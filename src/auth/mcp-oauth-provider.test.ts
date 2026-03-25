import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArgocdOAuthProvider } from './mcp-oauth-provider.js';

vi.mock('./settings.js', () => ({
  fetchOIDCSettings: vi.fn(),
  fetchOIDCProviderMetadata: vi.fn()
}));

vi.mock('./oauth.js', () => ({
  generateState: vi.fn().mockReturnValue('mock-upstream-state'),
  generatePKCEChallenge: vi.fn().mockReturnValue({
    codeVerifier: 'mock-verifier',
    codeChallenge: 'mock-challenge',
    codeChallengeMethod: 'S256'
  }),
  buildAuthorizationUrl: vi.fn().mockReturnValue('https://dex.example.com/auth?redirect_uri=...'),
  exchangeCodeForToken: vi.fn(),
  refreshAccessToken: vi.fn()
}));

vi.mock('../logging/logging.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

import { fetchOIDCSettings, fetchOIDCProviderMetadata } from './settings.js';
import { buildAuthorizationUrl, exchangeCodeForToken } from './oauth.js';

const mockOidcConfig = {
  issuer: 'https://dex.example.com',
  clientID: 'argo-cd-cli',
  scopes: ['openid', 'profile', 'email'],
  enablePKCEAuthentication: true,
  useDex: true
};

const mockProviderMetadata = {
  issuer: 'https://dex.example.com',
  authorization_endpoint: 'https://dex.example.com/auth',
  token_endpoint: 'https://dex.example.com/token'
};

describe('ArgocdOAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchOIDCSettings).mockResolvedValue(mockOidcConfig);
    vi.mocked(fetchOIDCProviderMetadata).mockResolvedValue(mockProviderMetadata);
  });

  describe('constructor callbackPort', () => {
    it('should use default port 8085 for callback URL', async () => {
      const provider = new ArgocdOAuthProvider('https://argocd.example.com');
      const mockRes = { redirect: vi.fn() } as any;

      await provider.authorize(
        { client_id: 'test', client_id_issued_at: 0, redirect_uris: ['http://localhost/callback'] } as any,
        { redirectUri: 'http://localhost/callback', codeChallenge: 'challenge', state: 'client-state' } as any,
        mockRes
      );

      expect(buildAuthorizationUrl).toHaveBeenCalledWith(
        mockProviderMetadata,
        mockOidcConfig,
        'http://localhost:8085/auth/callback',
        expect.any(String),
        expect.anything()
      );
    });

    it('should use custom port for callback URL', async () => {
      const provider = new ArgocdOAuthProvider('https://argocd.example.com', 9090);
      const mockRes = { redirect: vi.fn() } as any;

      await provider.authorize(
        { client_id: 'test', client_id_issued_at: 0, redirect_uris: ['http://localhost/callback'] } as any,
        { redirectUri: 'http://localhost/callback', codeChallenge: 'challenge', state: 'client-state' } as any,
        mockRes
      );

      expect(buildAuthorizationUrl).toHaveBeenCalledWith(
        mockProviderMetadata,
        mockOidcConfig,
        'http://localhost:9090/auth/callback',
        expect.any(String),
        expect.anything()
      );
    });
  });

  describe('handleUpstreamCallback', () => {
    it('should use the callbackPort-based URL when exchanging code', async () => {
      const provider = new ArgocdOAuthProvider('https://argocd.example.com', 7070);
      const mockRes = { redirect: vi.fn() } as any;

      vi.mocked(exchangeCodeForToken).mockResolvedValue({
        accessToken: 'argocd-token',
        refreshToken: 'argocd-refresh',
        expiresAt: Date.now() + 3600000
      });

      // First, authorize to create a pending auth entry
      await provider.authorize(
        { client_id: 'test-client', client_id_issued_at: 0, redirect_uris: ['http://localhost/callback'] } as any,
        { redirectUri: 'http://localhost/callback', codeChallenge: 'challenge', state: 'client-state' } as any,
        mockRes
      );

      // Handle the callback with the upstream state
      const redirectUrl = await provider.handleUpstreamCallback('upstream-code', 'mock-upstream-state');

      expect(exchangeCodeForToken).toHaveBeenCalledWith(
        mockProviderMetadata,
        mockOidcConfig,
        'upstream-code',
        'http://localhost:7070/auth/callback',
        expect.anything()
      );

      // Should redirect to the MCP client's redirect_uri with our auth code
      expect(redirectUrl).toContain('http://localhost/callback');
      expect(redirectUrl).toContain('code=');
      expect(redirectUrl).toContain('state=client-state');
    });
  });

  describe('client registration', () => {
    it('should register and retrieve clients', async () => {
      const provider = new ArgocdOAuthProvider('https://argocd.example.com');
      const store = provider.clientsStore;

      const registered = await store.registerClient!({
        redirect_uris: ['http://localhost/callback'],
        client_name: 'Test Client'
      } as any);

      expect(registered.client_id).toBeDefined();
      expect(registered.client_name).toBe('Test Client');

      const retrieved = await store.getClient(registered.client_id);
      expect(retrieved).toEqual(registered);
    });

    it('should return undefined for unknown client', async () => {
      const provider = new ArgocdOAuthProvider('https://argocd.example.com');
      const store = provider.clientsStore;

      const result = await store.getClient('nonexistent');
      expect(result).toBeUndefined();
    });
  });
});
