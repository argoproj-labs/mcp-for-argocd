import type { TokenRefreshProvider } from '../auth/token-refresh.js';

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

export class HttpClient {
  public readonly baseUrl: string;
  private apiToken: string;
  private headers: Record<string, string>;
  private tokenRefreshProvider?: TokenRefreshProvider;

  constructor(baseUrl: string, apiToken: string, tokenRefreshProvider?: TokenRefreshProvider) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.tokenRefreshProvider = tokenRefreshProvider;
    this.headers = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Update the API token and headers after a token refresh
   */
  public updateToken(newToken: string): void {
    this.apiToken = newToken;
    this.headers = {
      Authorization: `Bearer ${newToken}`,
      'Content-Type': 'application/json'
    };
  }

  private async requestInternal<R>(
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
    const response = await fetch(urlObject, {
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

  private async request<R>(
    url: string,
    params?: SearchParams,
    init?: RequestInit,
    isRetry: boolean = false
  ): Promise<HttpResponse<R>> {
    const response = await this.requestInternal<R>(url, params, init);

    // If we get a 401 and have a refresh provider, try to refresh the token and retry
    if (response.status === 401 && this.tokenRefreshProvider && !isRetry) {
      const newToken = await this.tokenRefreshProvider.refreshToken();
      if (newToken) {
        this.updateToken(newToken);
        return this.request<R>(url, params, init, true);
      }
    }

    return response;
  }

  private async requestStreamInternal<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => void,
    init?: RequestInit
  ): Promise<Response> {
    const urlObject = this.absUrl(url);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        urlObject.searchParams.set(key, value?.toString() || '');
      });
    }
    const response = await fetch(urlObject, {
      ...init,
      headers: { ...init?.headers, ...this.headers }
    });
    return response;
  }

  private async processStream<R>(response: Response, cb?: (chunk: R) => void): Promise<void> {
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

  private async requestStream<R>(
    url: string,
    params?: SearchParams,
    cb?: (chunk: R) => void,
    init?: RequestInit,
    isRetry: boolean = false
  ): Promise<void> {
    const response = await this.requestStreamInternal<R>(url, params, cb, init);

    // If we get a 401 and have a refresh provider, try to refresh the token and retry
    if (response.status === 401 && this.tokenRefreshProvider && !isRetry) {
      const newToken = await this.tokenRefreshProvider.refreshToken();
      if (newToken) {
        this.updateToken(newToken);
        return this.requestStream<R>(url, params, cb, init, true);
      }
    }

    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    await this.processStream<R>(response, cb);
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
