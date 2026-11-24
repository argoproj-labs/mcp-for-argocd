export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

// A non-2xx answer from ArgoCD. Thrown rather than returned, so a refused call
// reaches the tool caller as an error instead of as an empty result.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static async from(response: Response): Promise<HttpError> {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      const text = typeof body?.message === 'string' ? body.message : body?.error;
      if (typeof text === 'string' && text.trim()) detail = text.trim().slice(0, 500);
    } catch {
      // Not JSON (a proxy's HTML error page, an empty body): the status says enough.
    }
    return new HttpError(
      response.status,
      `ArgoCD answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}` +
        (detail ? `: ${detail}` : '')
    );
  }
}

type SearchParams = Record<string, string | number | boolean | undefined | null> | null;

export type HttpClientOptions = {
  // Called once when ArgoCD answers 401, for a token to retry the request with.
  // Used for short-lived tokens obtained by token exchange: a cached one can be
  // rejected (clock skew, key rotation) while still within its own lifetime.
  // It receives the token ArgoCD rejected.
  onUnauthorized?: (rejectedToken: string) => Promise<string | undefined>;
};

export class HttpClient {
  public readonly baseUrl: string;
  // Not readonly: replaced by the one retry after a 401.
  public apiToken: string;
  private readonly onUnauthorized?: (rejectedToken: string) => Promise<string | undefined>;

  constructor(baseUrl: string, apiToken: string, options: HttpClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.onUnauthorized = options.onUnauthorized;
  }

  public get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  private async send(url: URL, init?: RequestInit): Promise<Response> {
    const attempt = () => fetch(url, { ...init, headers: { ...init?.headers, ...this.headers } });
    const response = await attempt();
    if (response.status !== 401 || !this.onUnauthorized) return response;
    let fresh: string | undefined;
    try {
      fresh = await this.onUnauthorized(this.apiToken);
    } catch (error) {
      // The replacement could not be obtained (e.g. the exchange was refused); that
      // error says more than ArgoCD's 401 does.
      await response.body?.cancel();
      throw error;
    }
    if (!fresh || fresh === this.apiToken) return response;
    await response.body?.cancel();
    this.apiToken = fresh;
    return attempt();
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
    const response = await this.send(urlObject, init);
    if (!response.ok) throw await HttpError.from(response);
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
    const response = await this.send(urlObject, init);
    if (!response.ok) throw await HttpError.from(response);
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

  // Resolved under the base URL's path, so ArgoCD served under a prefix
  // (https://host/argocd) gets /argocd/api/v1/..., not /api/v1/... on whatever
  // else shares the host.
  absUrl(url: string): URL {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return new URL(url);
    }
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(url.replace(/^\/+/, ''), base);
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
