import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient } from './http.js';
import type { TokenRefreshProvider } from '../auth/token-refresh.js';

describe('HttpClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('request without refresh provider', () => {
    it('should make request with authorization header', async () => {
      const mockResponse = {
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: 'test' })
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new HttpClient('https://argocd.example.com', 'test-token');
      const result = await client.get<{ data: string }>('/api/test');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json'
          })
        })
      );
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: 'test' });
    });

    it('should return 401 error without retry when no refresh provider', async () => {
      const mockResponse = {
        status: 401,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ error: 'Unauthorized' })
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new HttpClient('https://argocd.example.com', 'test-token');
      const result = await client.get('/api/test');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(401);
    });
  });

  describe('request with refresh provider', () => {
    it('should retry request after successful token refresh on 401', async () => {
      const mockRefreshProvider: TokenRefreshProvider = {
        refreshToken: vi.fn().mockResolvedValue('new-token')
      };

      const responses = [
        {
          status: 401,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({ error: 'Unauthorized' })
        },
        {
          status: 200,
          headers: new Headers(),
          json: vi.fn().mockResolvedValue({ data: 'success' })
        }
      ];

      let callIndex = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve(responses[callIndex++]);
      });

      const client = new HttpClient(
        'https://argocd.example.com',
        'test-token',
        mockRefreshProvider
      );
      const result = await client.get<{ data: string }>('/api/test');

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mockRefreshProvider.refreshToken).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: 'success' });

      // Verify second request uses new token
      const secondCall = vi.mocked(fetch).mock.calls[1];
      expect(secondCall[1]?.headers).toMatchObject({
        Authorization: 'Bearer new-token'
      });
    });

    it('should return 401 when token refresh fails', async () => {
      const mockRefreshProvider: TokenRefreshProvider = {
        refreshToken: vi.fn().mockResolvedValue(null)
      };

      const mockResponse = {
        status: 401,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ error: 'Unauthorized' })
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new HttpClient(
        'https://argocd.example.com',
        'test-token',
        mockRefreshProvider
      );
      const result = await client.get('/api/test');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mockRefreshProvider.refreshToken).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(401);
    });

    it('should not retry more than once to prevent infinite loops', async () => {
      const mockRefreshProvider: TokenRefreshProvider = {
        refreshToken: vi.fn().mockResolvedValue('new-token')
      };

      // Both requests return 401 (e.g., refresh token is also invalid)
      const mockResponse = {
        status: 401,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ error: 'Unauthorized' })
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new HttpClient(
        'https://argocd.example.com',
        'test-token',
        mockRefreshProvider
      );
      const result = await client.get('/api/test');

      // Should only call fetch twice (original + one retry)
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mockRefreshProvider.refreshToken).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(401);
    });
  });

  describe('updateToken', () => {
    it('should update token and headers', async () => {
      const mockResponse = {
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ data: 'test' })
      };
      global.fetch = vi.fn().mockResolvedValue(mockResponse);

      const client = new HttpClient('https://argocd.example.com', 'old-token');
      client.updateToken('new-token');
      await client.get('/api/test');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-token'
          })
        })
      );
    });
  });
});
