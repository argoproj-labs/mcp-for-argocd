import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

// Mirrors the argocd CLI flags --client-crt, --client-crt-key, --server-crt, --insecure.
export interface TlsOptions {
  clientCrt?: string;
  clientCrtKey?: string;
  serverCrt?: string;
  insecure?: boolean;
}

// Process-wide: every HttpClient talks to Argo CD with the same TLS settings.
let dispatcher: Agent | undefined;

export const configureTls = ({ clientCrt, clientCrtKey, serverCrt, insecure }: TlsOptions) => {
  if (!clientCrt !== !clientCrtKey) {
    throw new Error('--client-crt and --client-crt-key must be set together');
  }
  dispatcher =
    clientCrt || serverCrt || insecure
      ? new Agent({
          connect: {
            cert: clientCrt ? readFileSync(clientCrt) : undefined,
            key: clientCrtKey ? readFileSync(clientCrtKey) : undefined,
            // Like the argocd CLI, --server-crt replaces the system trust store.
            ca: serverCrt ? readFileSync(serverCrt) : undefined,
            rejectUnauthorized: !insecure
          }
        })
      : undefined;
};

// undici's own fetch when a dispatcher is set: Node's bundled undici may not accept
// a dispatcher from a different undici version.
const doFetch = (url: URL, init: RequestInit): Promise<Response> =>
  dispatcher
    ? (undiciFetch(url, {
        ...(init as UndiciRequestInit),
        dispatcher
      }) as unknown as Promise<Response>)
    : fetch(url, init);

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
