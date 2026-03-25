import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { fetchOIDCSettings, fetchOIDCProviderMetadata } from './settings.js';
import { generateState, generatePKCEChallenge, buildAuthorizationUrl, exchangeCodeForToken, refreshAccessToken } from './oauth.js';
import type { OIDCConfig, OIDCProviderMetadata, PKCEChallenge, TokenInfo } from './types.js';
import { logger } from '../logging/logging.js';

interface PendingAuth {
  /** Our generated state for the upstream OIDC flow */
  upstreamState: string;
  /** PKCE challenge we generated for the upstream flow */
  upstreamPkce: PKCEChallenge;
  /** MCP client's redirect_uri to redirect back to after auth */
  clientRedirectUri: string;
  /** MCP client's original state */
  clientState?: string;
  /** The PKCE code_challenge from the MCP client */
  clientCodeChallenge: string;
  /** The MCP client ID */
  clientId: string;
  /** Timestamp for cleanup */
  createdAt: number;
}

interface CompletedAuth {
  /** ArgoCD tokens from the upstream exchange */
  argocdToken: TokenInfo;
  /** OIDC config used (for refresh) */
  oidcConfig: OIDCConfig;
  /** Provider metadata used (for refresh) */
  providerMetadata: OIDCProviderMetadata;
  /** MCP client's redirect_uri */
  clientRedirectUri: string;
  /** MCP client's original state */
  clientState?: string;
  /** The PKCE code_challenge from the MCP client */
  clientCodeChallenge: string;
  /** The MCP client ID */
  clientId: string;
  /** Timestamp for cleanup */
  createdAt: number;
}

interface StoredToken {
  argocdAccessToken: string;
  argocdRefreshToken?: string;
  oidcConfig: OIDCConfig;
  providerMetadata: OIDCProviderMetadata;
  clientId: string;
  expiresAt?: number;
  createdAt: number;
}

function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Custom OAuthServerProvider that proxies MCP OAuth 2.1 to ArgoCD's OIDC/Dex.
 *
 * Flow:
 * 1. MCP client registers dynamically (or uses existing registration)
 * 2. MCP client starts OAuth flow → we redirect to ArgoCD's OIDC provider
 * 3. User authenticates with ArgoCD OIDC → callback comes to us
 * 4. We exchange upstream code for ArgoCD tokens, generate our own auth code
 * 5. MCP client exchanges our auth code for our opaque access token
 * 6. On each MCP request, we verify the opaque token and use the stored ArgoCD token
 */
export class ArgocdOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pendingAuths = new Map<string, PendingAuth>();
  private completedAuths = new Map<string, CompletedAuth>();
  private accessTokens = new Map<string, StoredToken>();
  private refreshTokens = new Map<string, { upstreamRefreshToken: string; oidcConfig: OIDCConfig; providerMetadata: OIDCProviderMetadata; clientId: string }>();

  private cachedOidcConfig?: OIDCConfig;
  private cachedProviderMetadata?: OIDCProviderMetadata;
  private cleanupInterval: ReturnType<typeof setInterval>;

  readonly skipLocalPkceValidation = false;

  private callbackUrl: string;

  constructor(
    private argocdServerUrl: string,
    callbackPort: number = 8085,
    private insecure: boolean = false
  ) {
    this.callbackUrl = `http://localhost:${callbackPort}/auth/callback`;
    // Periodic cleanup of stale state (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    // Don't keep process alive just for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.clients.get(clientId),
      registerClient: (clientMetadata) => {
        const clientId = randomBytes(16).toString('hex');
        const client: OAuthClientInformationFull = {
          ...clientMetadata,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(clientId, client);
        logger.info({ clientId, clientName: client.client_name }, 'Registered new MCP OAuth client');
        return client;
      },
    };
  }

  /**
   * Lazily fetch and cache the ArgoCD OIDC configuration
   */
  private async getOidcConfig(): Promise<{ oidcConfig: OIDCConfig; providerMetadata: OIDCProviderMetadata }> {
    if (this.cachedOidcConfig && this.cachedProviderMetadata) {
      return { oidcConfig: this.cachedOidcConfig, providerMetadata: this.cachedProviderMetadata };
    }

    logger.info({ serverUrl: this.argocdServerUrl }, 'Fetching ArgoCD OIDC configuration');
    const oidcConfig = await fetchOIDCSettings(this.argocdServerUrl);
    const providerMetadata = await fetchOIDCProviderMetadata(oidcConfig);

    this.cachedOidcConfig = oidcConfig;
    this.cachedProviderMetadata = providerMetadata;

    return { oidcConfig, providerMetadata };
  }

  /**
   * Start authorization: redirect to ArgoCD's OIDC provider
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const { oidcConfig, providerMetadata } = await this.getOidcConfig();

    // Generate our own PKCE for the upstream OIDC flow
    const upstreamPkce = oidcConfig.enablePKCEAuthentication ? generatePKCEChallenge() : undefined;
    const upstreamState = generateState();

    const callbackUrl = this.callbackUrl;

    // Store pending auth keyed by upstream state
    this.pendingAuths.set(upstreamState, {
      upstreamState,
      upstreamPkce: upstreamPkce ?? { codeVerifier: '', codeChallenge: '', codeChallengeMethod: 'S256' },
      clientRedirectUri: params.redirectUri,
      clientState: params.state,
      clientCodeChallenge: params.codeChallenge,
      clientId: client.client_id,
      createdAt: Date.now(),
    });

    // Build the upstream authorization URL
    const authUrl = buildAuthorizationUrl(
      providerMetadata,
      oidcConfig,
      callbackUrl,
      upstreamState,
      upstreamPkce
    );

    logger.info({ clientId: client.client_id }, 'Redirecting to upstream OIDC provider for authentication');
    res.redirect(authUrl);
  }

  /**
   * Handle the callback from ArgoCD's OIDC provider.
   * Called from the /callback route.
   *
   * Returns the MCP client's redirect URI with our auth code appended.
   */
  async handleUpstreamCallback(code: string, state: string): Promise<string> {
    const pending = this.pendingAuths.get(state);
    if (!pending) {
      throw new Error('Unknown or expired authorization state');
    }
    this.pendingAuths.delete(state);

    const { oidcConfig, providerMetadata } = await this.getOidcConfig();
    const callbackUrl = this.callbackUrl;

    // Exchange the upstream code for ArgoCD tokens
    const argocdToken = await exchangeCodeForToken(
      providerMetadata,
      oidcConfig,
      code,
      callbackUrl,
      pending.upstreamPkce.codeVerifier ? pending.upstreamPkce : undefined
    );

    // Generate our own auth code for the MCP client
    const ourAuthCode = generateOpaqueToken();

    this.completedAuths.set(ourAuthCode, {
      argocdToken,
      oidcConfig,
      providerMetadata,
      clientRedirectUri: pending.clientRedirectUri,
      clientState: pending.clientState,
      clientCodeChallenge: pending.clientCodeChallenge,
      clientId: pending.clientId,
      createdAt: Date.now(),
    });

    // Build redirect back to MCP client
    const redirectUrl = new URL(pending.clientRedirectUri);
    redirectUrl.searchParams.set('code', ourAuthCode);
    if (pending.clientState) {
      redirectUrl.searchParams.set('state', pending.clientState);
    }

    logger.info({ clientId: pending.clientId }, 'Upstream authentication completed, redirecting to MCP client');
    return redirectUrl.toString();
  }

  /**
   * Return the PKCE code_challenge for a given auth code
   */
  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const completed = this.completedAuths.get(authorizationCode);
    if (!completed) {
      throw new Error('Unknown or expired authorization code');
    }
    return completed.clientCodeChallenge;
  }

  /**
   * Exchange our auth code for an opaque access token
   */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const completed = this.completedAuths.get(authorizationCode);
    if (!completed) {
      throw new Error('Unknown or expired authorization code');
    }
    this.completedAuths.delete(authorizationCode);

    // Generate opaque tokens that map to the real ArgoCD tokens
    const opaqueAccessToken = generateOpaqueToken();
    const opaqueRefreshToken = completed.argocdToken.refreshToken ? generateOpaqueToken() : undefined;

    this.accessTokens.set(opaqueAccessToken, {
      argocdAccessToken: completed.argocdToken.accessToken,
      argocdRefreshToken: completed.argocdToken.refreshToken,
      oidcConfig: completed.oidcConfig,
      providerMetadata: completed.providerMetadata,
      clientId: client.client_id,
      expiresAt: completed.argocdToken.expiresAt,
      createdAt: Date.now(),
    });

    if (opaqueRefreshToken && completed.argocdToken.refreshToken) {
      this.refreshTokens.set(opaqueRefreshToken, {
        upstreamRefreshToken: completed.argocdToken.refreshToken,
        oidcConfig: completed.oidcConfig,
        providerMetadata: completed.providerMetadata,
        clientId: client.client_id,
      });
    }

    const tokens: OAuthTokens = {
      access_token: opaqueAccessToken,
      token_type: 'Bearer',
      expires_in: completed.argocdToken.expiresAt
        ? Math.floor((completed.argocdToken.expiresAt - Date.now()) / 1000)
        : undefined,
      refresh_token: opaqueRefreshToken,
    };

    logger.info({ clientId: client.client_id }, 'Issued MCP access token');
    return tokens;
  }

  /**
   * Refresh: exchange our opaque refresh token for a new opaque access token
   */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken);
    if (!stored) {
      throw new Error('Unknown or expired refresh token');
    }

    // Refresh upstream token
    const newArgocdToken = await refreshAccessToken(
      stored.providerMetadata,
      stored.oidcConfig,
      stored.upstreamRefreshToken,
    );

    // Generate new opaque tokens
    const newAccessToken = generateOpaqueToken();
    const newRefreshToken = newArgocdToken.refreshToken ? generateOpaqueToken() : undefined;

    this.accessTokens.set(newAccessToken, {
      argocdAccessToken: newArgocdToken.accessToken,
      argocdRefreshToken: newArgocdToken.refreshToken,
      oidcConfig: stored.oidcConfig,
      providerMetadata: stored.providerMetadata,
      clientId: client.client_id,
      expiresAt: newArgocdToken.expiresAt,
      createdAt: Date.now(),
    });

    // Remove old refresh token, add new one
    this.refreshTokens.delete(refreshToken);
    if (newRefreshToken && newArgocdToken.refreshToken) {
      this.refreshTokens.set(newRefreshToken, {
        upstreamRefreshToken: newArgocdToken.refreshToken,
        oidcConfig: stored.oidcConfig,
        providerMetadata: stored.providerMetadata,
        clientId: client.client_id,
      });
    }

    const tokens: OAuthTokens = {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: newArgocdToken.expiresAt
        ? Math.floor((newArgocdToken.expiresAt - Date.now()) / 1000)
        : undefined,
      refresh_token: newRefreshToken,
    };

    logger.info({ clientId: client.client_id }, 'Refreshed MCP access token');
    return tokens;
  }

  /**
   * Verify an opaque access token and return AuthInfo with the real ArgoCD credentials
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token);
    if (!stored) {
      throw new Error('Invalid or expired access token');
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: [],
      expiresAt: stored.expiresAt ? Math.floor(stored.expiresAt / 1000) : undefined,
      extra: {
        argocdToken: stored.argocdAccessToken,
        argocdBaseUrl: this.argocdServerUrl,
      },
    };
  }

  /**
   * Clean up expired/stale state
   */
  private cleanup(): void {
    const now = Date.now();
    const pendingMaxAge = 10 * 60 * 1000; // 10 minutes
    const completedMaxAge = 5 * 60 * 1000; // 5 minutes

    for (const [key, pending] of this.pendingAuths) {
      if (now - pending.createdAt > pendingMaxAge) {
        this.pendingAuths.delete(key);
      }
    }

    for (const [key, completed] of this.completedAuths) {
      if (now - completed.createdAt > completedMaxAge) {
        this.completedAuths.delete(key);
      }
    }

    // Clean up expired access tokens
    for (const [key, stored] of this.accessTokens) {
      if (stored.expiresAt && now > stored.expiresAt) {
        this.accessTokens.delete(key);
      }
    }
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  dispose(): void {
    clearInterval(this.cleanupInterval);
  }
}
