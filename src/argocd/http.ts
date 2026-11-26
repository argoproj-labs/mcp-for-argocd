import type { RuntimeError, RuntimeStreamError } from '../types/argocd-types.js';
import { ArgoCDApiError } from './errors.js';
import { buildArgoCDUrl } from './url.js';

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  allowEmptyBody?: boolean;
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const isRedirectResponse = (response: Response): boolean => REDIRECT_STATUSES.has(response.status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatErrorDetails = (details: unknown): string | undefined =>
  details !== undefined ? JSON.stringify(details).slice(0, 500) : undefined;

const toStreamApiError = (
  streamError: RuntimeStreamError,
  fallbackStatus: number,
  fallbackMessage: string
): ArgoCDApiError => {
  const status =
    typeof streamError.http_code === 'number' && streamError.http_code >= 400
      ? streamError.http_code
      : fallbackStatus;
  const message =
    (typeof streamError.message === 'string' && streamError.message.trim()) ||
    (typeof streamError.http_status === 'string' && streamError.http_status.trim()) ||
    fallbackMessage;
  const argoCode = typeof streamError.grpc_code === 'number' ? streamError.grpc_code : undefined;
  return new ArgoCDApiError(status, message, argoCode, formatErrorDetails(streamError.details));
};

const parseErrorResponse = async (response: Response): Promise<ArgoCDApiError> => {
  const fallbackMessage = `HTTP ${response.status} ${response.statusText || 'Error'}`.trim();
  const rawText = await response.text().catch(() => '');
  const trimmed = rawText.trim();
  if (!trimmed) {
    return new ArgoCDApiError(response.status, fallbackMessage);
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return new ArgoCDApiError(
        response.status,
        `HTTP ${response.status}: ${trimmed.slice(0, 500)}`
      );
    }
    if (isRecord(parsed.error)) {
      return toStreamApiError(parsed.error as RuntimeStreamError, response.status, fallbackMessage);
    }
    const runtimeError = parsed as RuntimeError;
    const msg =
      (typeof runtimeError.message === 'string' && runtimeError.message.trim()) ||
      (typeof runtimeError.error === 'string' && runtimeError.error.trim()) ||
      fallbackMessage;
    return new ArgoCDApiError(
      response.status,
      msg,
      typeof runtimeError.code === 'number' ? runtimeError.code : undefined,
      formatErrorDetails(runtimeError.details)
    );
  } catch {
    return new ArgoCDApiError(response.status, `HTTP ${response.status}: ${trimmed.slice(0, 500)}`);
  }
};

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

  private buildUrl(url: string, params?: SearchParams): URL {
    const urlObject = this.absUrl(url);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          urlObject.searchParams.set(key, String(value));
        }
      }
    }
    return urlObject;
  }

  private async request<R>(
    url: string,
    params?: SearchParams,
    init?: RequestInit,
    options?: Pick<RequestOptions, 'allowEmptyBody'>
  ): Promise<HttpResponse<R>> {
    const urlObject = this.buildUrl(url, params);
    const response = await fetch(urlObject, {
      ...init,
      redirect: 'manual',
      headers: { ...init?.headers, ...this.headers }
    });
    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => {});
      throw new ArgoCDApiError(
        response.status,
        `Argo CD API returned unexpected HTTP ${response.status} redirect; redirects are not followed to protect credentials.`
      );
    }
    if (!response.ok) {
      throw await parseErrorResponse(response);
    }
    const text = await response.text();
    if (!text.trim()) {
      if (options?.allowEmptyBody) {
        return {
          status: response.status,
          headers: response.headers,
          body: {} as R
        };
      }
      throw new ArgoCDApiError(
        response.status,
        `Argo CD API returned an empty response body (HTTP ${response.status}).`
      );
    }
    const body = JSON.parse(text) as R;
    return {
      status: response.status,
      headers: response.headers,
      body
    };
  }

  private async requestStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => void,
    options?: Pick<RequestOptions, 'headers'>
  ) {
    const urlObject = this.buildUrl(url, params);
    const response = await fetch(urlObject, {
      redirect: 'manual',
      headers: { ...options?.headers, ...this.headers }
    });
    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => {});
      throw new ArgoCDApiError(
        response.status,
        `Argo CD API returned unexpected HTTP ${response.status} redirect; redirects are not followed to protect credentials.`
      );
    }
    if (!response.ok) {
      throw await parseErrorResponse(response);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('response body is not readable');
    }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let reachedEof = false;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const json: unknown = JSON.parse(trimmed);
      if (!isRecord(json)) return;
      if (json.error !== undefined) {
        const fallbackStatus = response.status >= 400 ? response.status : 500;
        if (isRecord(json.error)) {
          throw toStreamApiError(
            json.error as RuntimeStreamError,
            fallbackStatus,
            'Argo CD stream returned an error'
          );
        }
        throw new ArgoCDApiError(
          fallbackStatus,
          typeof json.error === 'string' && json.error.trim()
            ? json.error
            : 'Argo CD stream returned an error'
        );
      }
      if (json.result !== undefined) {
        cb?.(json.result as R);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          reachedEof = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        processLine(buffer);
      }
    } finally {
      if (!reachedEof) {
        await reader.cancel().catch(() => {});
      }
      reader.releaseLock();
    }
  }

  absUrl(url: string): URL {
    return buildArgoCDUrl(this.baseUrl, url);
  }

  async get<R>(
    url: string,
    params?: SearchParams,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(url, params, { headers: options?.headers }, options);
  }

  async getStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => void,
    options?: Pick<RequestOptions, 'headers'>
  ): Promise<void> {
    await this.requestStream<R>(url, params, cb, options);
  }

  async post<T, R>(
    url: string,
    params?: SearchParams,
    body?: T,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(
      url,
      params,
      {
        method: 'POST',
        headers: options?.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      },
      options
    );
  }

  async put<T, R>(
    url: string,
    params?: SearchParams,
    body?: T,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(
      url,
      params,
      {
        method: 'PUT',
        headers: options?.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      },
      options
    );
  }

  async delete<R>(
    url: string,
    params?: SearchParams,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(
      url,
      params,
      {
        method: 'DELETE',
        headers: options?.headers
      },
      options
    );
  }
}
