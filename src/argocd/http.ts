import { ArgoCDApiError } from './errors.js';
import { buildArgoCDUrl } from './url.js';

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestOptions {
  headers?: Record<string, string>;
}

export interface StreamOptions extends RequestOptions {
  maxBytes?: number;
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

const parseErrorBody = async (
  response: Response
): Promise<{ message: string; argoCode?: number; details?: string }> => {
  const rawText = await response.text().catch(() => '');
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { message: `HTTP ${response.status} ${response.statusText || 'Error'}`.trim() };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: string;
      error?: string;
      code?: number;
      details?: unknown;
    };
    const msg =
      parsed.message ||
      parsed.error ||
      `HTTP ${response.status} ${response.statusText || 'Error'}`.trim();
    const details =
      parsed.details !== undefined ? JSON.stringify(parsed.details).slice(0, 500) : undefined;
    return {
      message: msg,
      argoCode: typeof parsed.code === 'number' ? parsed.code : undefined,
      details
    };
  } catch {
    return {
      message: `HTTP ${response.status}: ${trimmed.slice(0, 500)}`
    };
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
    init?: RequestInit
  ): Promise<HttpResponse<R>> {
    const urlObject = this.buildUrl(url, params);
    const response = await fetch(urlObject, {
      ...init,
      headers: { ...init?.headers, ...this.headers }
    });
    if (!response.ok) {
      const { message, argoCode, details } = await parseErrorBody(response);
      throw new ArgoCDApiError(response.status, message, argoCode, details);
    }
    const text = await response.text();
    const body = (text.trim() ? JSON.parse(text) : {}) as R;
    return {
      status: response.status,
      headers: response.headers,
      body
    };
  }

  private async requestStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => boolean | void,
    options?: StreamOptions
  ) {
    const urlObject = this.buildUrl(url, params);
    const response = await fetch(urlObject, {
      headers: { ...options?.headers, ...this.headers }
    });
    if (!response.ok) {
      const { message, argoCode, details } = await parseErrorBody(response);
      throw new ArgoCDApiError(response.status, message, argoCode, details);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('response body is not readable');
    }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let bytesRead = 0;
    const maxBytes = options?.maxBytes;
    let stop = false;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || stop) return;
      const json = JSON.parse(trimmed) as {
        result?: R;
        error?: { message?: string; code?: number };
      };
      if (json.error) {
        throw new ArgoCDApiError(
          response.status >= 400 ? response.status : 500,
          json.error.message || 'Argo CD stream returned an error',
          json.error.code
        );
      }
      if (json.result !== undefined) {
        const keepGoing = cb?.(json.result);
        if (keepGoing === false) {
          stop = true;
        }
      }
    };

    try {
      while (!stop) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytesRead += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          processLine(line);
          if (stop) break;
        }

        if (maxBytes !== undefined && bytesRead >= maxBytes) {
          stop = true;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() && !stop) {
        processLine(buffer);
      }
    } finally {
      if (stop) {
        await reader.cancel().catch(() => {});
      }
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
    return await this.request<R>(url, params, { headers: options?.headers });
  }

  async getStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => boolean | void,
    options?: StreamOptions
  ): Promise<void> {
    await this.requestStream<R>(url, params, cb, options);
  }

  async post<T, R>(
    url: string,
    params?: SearchParams,
    body?: T,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(url, params, {
      method: 'POST',
      headers: options?.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  async put<T, R>(
    url: string,
    params?: SearchParams,
    body?: T,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(url, params, {
      method: 'PUT',
      headers: options?.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  async delete<R>(
    url: string,
    params?: SearchParams,
    options?: RequestOptions
  ): Promise<HttpResponse<R>> {
    return await this.request<R>(url, params, {
      method: 'DELETE',
      headers: options?.headers
    });
  }
}
