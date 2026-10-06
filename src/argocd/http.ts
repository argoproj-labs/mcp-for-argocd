import { readFileSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import {
  Agent,
  Dispatcher,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit
} from 'undici';

// Mirrors the argocd CLI flags --client-crt, --client-crt-key, --server-crt, --insecure.
export interface TlsOptions {
  clientCrt?: string;
  clientCrtKey?: string;
  serverCrt?: string;
  insecure?: boolean;
}

// Node's fetch only honours HTTP(S)_PROXY with NODE_USE_ENV_PROXY=1 / --use-env-proxy;
// do the same so TLS options don't turn a proxied connection into a direct one.
const useEnvProxy =
  process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy');

const newAgent = (tls?: Agent.Options['connect']): Dispatcher =>
  useEnvProxy
    ? new EnvHttpProxyAgent({ connect: tls, requestTls: tls } as EnvHttpProxyAgent.Options)
    : new Agent({ connect: tls });

// TLS settings are bound to operator-configured origins (ARGOCD_BASE_URL and registry
// entries), so one instance's client cert or --insecure never applies to another.
const agentsByOrigin = new Map<string, Dispatcher>();
const tlsHostnames = new Set<string>();
const optionsByOrigin = new Map<string, string>();

export const configureTls = (
  baseUrl: string | undefined,
  { clientCrt, clientCrtKey, serverCrt, insecure }: TlsOptions
) => {
  if (!clientCrt && !clientCrtKey && !serverCrt && !insecure) return;
  if (!clientCrt !== !clientCrtKey) {
    throw new Error('--client-crt and --client-crt-key must be set together');
  }
  if (!baseUrl) {
    throw new Error('TLS options need a base URL to bind to: set ARGOCD_BASE_URL');
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`TLS options for ${url.origin} need an https:// base URL`);
  }
  // Several registry entries (or the CLI flags) may share an origin: fine if they agree.
  const options = JSON.stringify([clientCrt, clientCrtKey, serverCrt, !!insecure]);
  const existing = optionsByOrigin.get(url.origin);
  if (existing === options) return;
  if (existing) {
    throw new Error(`Conflicting TLS options configured for ${url.origin}`);
  }
  optionsByOrigin.set(url.origin, options);
  agentsByOrigin.set(
    url.origin,
    newAgent({
      cert: clientCrt ? readFileSync(clientCrt) : undefined,
      key: clientCrtKey ? readFileSync(clientCrtKey) : undefined,
      // Like the argocd CLI, --server-crt is appended to the default roots.
      // ponytail: bundled roots only; NODE_EXTRA_CA_CERTS / --use-system-ca are not merged in.
      ca: serverCrt ? [...rootCertificates, readFileSync(serverCrt, 'utf8')] : undefined,
      rejectUnauthorized: !insecure
    })
  );
  tlsHostnames.add(url.hostname);
};

// A typo'd http:// URL for a TLS-configured host would skip the handshake and send
// the bearer token in cleartext.
const assertTlsScheme = (url: URL) => {
  if (url.protocol === 'http:' && tlsHostnames.has(url.hostname)) {
    throw new Error(`Refusing http:// request to ${url.host}: TLS options are configured for it`);
  }
};

// Picks the dispatcher per origin on every hop, so redirects are checked again.
class OriginRouter extends Dispatcher {
  private fallback = newAgent();

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const url = new URL(String(opts.origin));
    assertTlsScheme(url);
    return (agentsByOrigin.get(url.origin) ?? this.fallback).dispatch(opts, handler);
  }
}

let router: OriginRouter | undefined;

// undici's own fetch when TLS is configured: Node's bundled undici may not accept
// a dispatcher from a different undici version.
const doFetch = (url: URL, init: RequestInit): Promise<Response> => {
  if (agentsByOrigin.size === 0) return fetch(url, init);
  assertTlsScheme(url);
  router ??= new OriginRouter();
  return undiciFetch(url, {
    ...(init as UndiciRequestInit),
    dispatcher: router
  }) as unknown as Promise<Response>;
};

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

export class HttpClient {
  public readonly baseUrl: string;
  public readonly apiToken: string;
  public readonly headers: Record<string, string>;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.headers = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  private async request<R>(
    url: string,
    params?: SearchParams,
    init?: RequestInit
  ): Promise<HttpResponse<R>> {
    const urlObject = this.absUrl(url);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        urlObject.searchParams.set(key, value?.toString() || '');
      });
    }
    const response = await doFetch(urlObject, {
      ...init,
      headers: { ...init?.headers, ...this.headers }
    });
    const body = await response.json();
    return {
      status: response.status,
      headers: response.headers,
      body: body as R
    };
  }

  private async requestStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => void,
    init?: RequestInit
  ) {
    const urlObject = this.absUrl(url);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        urlObject.searchParams.set(key, value?.toString() || '');
      });
    }
    const response = await doFetch(urlObject, {
      ...init,
      headers: { ...init?.headers, ...this.headers }
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('response body is not readable');
    }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          const json = JSON.parse(line);
          cb?.(json['result']);
        }
      }
    }
  }

  absUrl(url: string): URL {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return new URL(url);
    }
    return new URL(url, this.baseUrl);
  }

  async get<R>(url: string, params?: SearchParams): Promise<HttpResponse<R>> {
    const response = await this.request<R>(url, params);
    return response;
  }

  async getStream<R>(url: string, params?: SearchParams, cb?: (chunk: R) => void): Promise<void> {
    await this.requestStream<R>(url, params, cb);
  }

  async post<T, R>(url: string, params?: SearchParams, body?: T): Promise<HttpResponse<R>> {
    const response = await this.request<R>(url, params, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined
    });
    return response;
  }

  async put<T, R>(url: string, params?: SearchParams, body?: T): Promise<HttpResponse<R>> {
    const response = await this.request<R>(url, params, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined
    });
    return response;
  }

  async delete<R>(url: string, params?: SearchParams): Promise<HttpResponse<R>> {
    const response = await this.request<R>(url, params, {
      method: 'DELETE'
    });
    return response;
  }
}
