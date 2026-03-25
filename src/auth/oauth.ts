import { createHash, randomBytes } from 'node:crypto';
import type { OIDCConfig, OIDCProviderMetadata, PKCEChallenge, TokenInfo } from './types.js';

/**
 * Generate a cryptographically secure random string for state parameter
 */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate PKCE code verifier and challenge
 * Following RFC 7636 specifications
 */
export function generatePKCEChallenge(): PKCEChallenge {
  // Generate 32 bytes of random data, encoded as base64url (43 chars)
  const codeVerifier = randomBytes(32).toString('base64url');

  // SHA256 hash of verifier, base64url encoded
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256'
  };
}

/**
 * Build the OAuth2 authorization URL
 */
export function buildAuthorizationUrl(
  providerMetadata: OIDCProviderMetadata,
  oidcConfig: OIDCConfig,
  redirectUri: string,
  state: string,
  pkce?: PKCEChallenge
): string {
  const url = new URL(providerMetadata.authorization_endpoint);

  url.searchParams.set('client_id', oidcConfig.clientID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', oidcConfig.scopes.join(' '));
  url.searchParams.set('state', state);

  if (pkce) {
    url.searchParams.set('code_challenge', pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
  }

  return url.toString();
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(
  providerMetadata: OIDCProviderMetadata,
  oidcConfig: OIDCConfig,
  code: string,
  redirectUri: string,
  pkce?: PKCEChallenge
): Promise<TokenInfo> {
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('client_id', oidcConfig.clientID);
  params.set('code', code);
  params.set('redirect_uri', redirectUri);

  if (pkce) {
    params.set('code_verifier', pkce.codeVerifier);
  }

  const response = await fetch(providerMetadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  const tokenResponse = (await response.json()) as TokenResponse;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    idToken: tokenResponse.id_token,
    expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : undefined
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  providerMetadata: OIDCProviderMetadata,
  oidcConfig: OIDCConfig,
  refreshToken: string
): Promise<TokenInfo> {
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('client_id', oidcConfig.clientID);
  params.set('refresh_token', refreshToken);

  const response = await fetch(providerMetadata.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status} ${response.statusText} - ${errorBody}`
    );
  }

  const tokenResponse = (await response.json()) as TokenResponse;

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || refreshToken, // Keep old refresh token if not provided
    idToken: tokenResponse.id_token,
    expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : undefined
  };
}
