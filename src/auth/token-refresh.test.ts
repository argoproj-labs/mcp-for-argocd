import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTokenRefreshProvider } from './token-refresh.js';

// Mock dependencies
vi.mock('./token-store.js', () => ({
  loadToken: vi.fn(),
  saveToken: vi.fn()
}));

vi.mock('./settings.js', () => ({
  fetchOIDCProviderMetadata: vi.fn()
}));

vi.mock('./oauth.js', () => ({
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

import { loadToken, saveToken } from './token-store.js';
import { fetchOIDCProviderMetadata } from './settings.js';
import { refreshAccessToken } from './oauth.js';

describe('createTokenRefreshProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when no stored auth exists', async () => {
    vi.mocked(loadToken).mockResolvedValue(null);

    const provider = createTokenRefreshProvider('https://argocd.example.com');
    const result = await provider.refreshToken();

    expect(result).toBeNull();
    expect(loadToken).toHaveBeenCalledWith('https://argocd.example.com');
  });

  it('should return null when stored auth has no refresh token', async () => {
    vi.mocked(loadToken).mockResolvedValue({
      serverUrl: 'https://argocd.example.com',
      token: {
        accessToken: 'old-access-token'
        // no refreshToken
      },
      oidcConfig: {
        issuer: 'https://issuer.example.com',
        clientID: 'client-id',
        scopes: ['openid'],
        enablePKCEAuthentication: false,
        useDex: false
      },
      storedAt: Date.now()
    });

    const provider = createTokenRefreshProvider('https://argocd.example.com');
    const result = await provider.refreshToken();

    expect(result).toBeNull();
    expect(fetchOIDCProviderMetadata).not.toHaveBeenCalled();
  });

  it('should refresh token and save it when refresh token is available', async () => {
    const storedAuth = {
      serverUrl: 'https://argocd.example.com',
      token: {
        accessToken: 'old-access-token',
        refreshToken: 'refresh-token'
      },
      oidcConfig: {
        issuer: 'https://issuer.example.com',
        clientID: 'client-id',
        scopes: ['openid'],
        enablePKCEAuthentication: false,
        useDex: false
      },
      storedAt: Date.now()
    };

    const providerMetadata = {
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token'
    };

    const newToken = {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: Date.now() + 3600000
    };

    vi.mocked(loadToken).mockResolvedValue(storedAuth);
    vi.mocked(fetchOIDCProviderMetadata).mockResolvedValue(providerMetadata);
    vi.mocked(refreshAccessToken).mockResolvedValue(newToken);

    const provider = createTokenRefreshProvider('https://argocd.example.com');
    const result = await provider.refreshToken();

    expect(result).toBe('new-access-token');
    expect(fetchOIDCProviderMetadata).toHaveBeenCalledWith(storedAuth.oidcConfig);
    expect(refreshAccessToken).toHaveBeenCalledWith(
      providerMetadata,
      storedAuth.oidcConfig,
      'refresh-token'
    );
    expect(saveToken).toHaveBeenCalledWith(
      'https://argocd.example.com',
      newToken,
      storedAuth.oidcConfig
    );
  });

  it('should return null and log error when refresh fails', async () => {
    const storedAuth = {
      serverUrl: 'https://argocd.example.com',
      token: {
        accessToken: 'old-access-token',
        refreshToken: 'refresh-token'
      },
      oidcConfig: {
        issuer: 'https://issuer.example.com',
        clientID: 'client-id',
        scopes: ['openid'],
        enablePKCEAuthentication: false,
        useDex: false
      },
      storedAt: Date.now()
    };

    vi.mocked(loadToken).mockResolvedValue(storedAuth);
    vi.mocked(fetchOIDCProviderMetadata).mockRejectedValue(new Error('OIDC provider unreachable'));

    const provider = createTokenRefreshProvider('https://argocd.example.com');
    const result = await provider.refreshToken();

    expect(result).toBeNull();
    expect(saveToken).not.toHaveBeenCalled();
  });
});
