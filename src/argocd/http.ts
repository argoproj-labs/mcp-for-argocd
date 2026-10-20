import type { TokenProvider } from './tokenProvider.js';

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

export class HttpClient {
  public readonly baseUrl: string;
  public readonly tokenProvider: TokenProvider;

  constructor(baseUrl: string, tokenProvider: TokenProvider) {
    this.baseUrl = baseUrl;
    this.tokenProvider = tokenProvider;
  }

  // Send a request with the bearer token resolved from the provider at call
  // time, so a long-lived client always carries the provider's current token.
  //
  // If ArgoCD rejects the token (401) and the provider can produce a fresh one,
  // the cached token is dropped and the request is sent once more. A 401 means
  // the request was rejected before being acted on, so the retry is safe for
  // mutating requests too. A second 401 is returned to the caller as-is.
  private async fetchWithAuth(url: URL, init?: RequestInit): Promise<Response> {
    const send = async () =>
      fetch(url, {
        ...init,
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${await this.tokenProvider.getToken()}`,
          'Content-Type': 'application/json'
        }
      });
    const response = await send();
    if (response.status !== 401 || !this.tokenProvider.invalidate()) {
      return response;
    }
    return send();
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
    const response = await this.fetchWithAuth(urlObject, init);
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
    const response = await this.fetchWithAuth(urlObject, init);
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
