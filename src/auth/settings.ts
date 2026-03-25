import type { ClusterSettings } from '../types/argocd-types.js';
import type { OIDCConfig, OIDCProviderMetadata } from './types.js';

export class SSONotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSONotConfiguredError';
  }
}

/**
 * Fetch ArgoCD server settings including OIDC configuration
 */
export async function fetchArgoSettings(baseUrl: string): Promise<ClusterSettings> {
  const url = new URL('/api/v1/settings', baseUrl);
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ArgoCD settings: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ClusterSettings;
}

/**
 * Extract OIDC configuration from ArgoCD settings
 * Supports both direct OIDC and Dex-based SSO
 */
export async function fetchOIDCSettings(baseUrl: string): Promise<OIDCConfig> {
  const settings = await fetchArgoSettings(baseUrl);

  // Check for Dex configuration first (bundled OIDC provider)
  if (settings.dexConfig && settings.dexConfig.connectors?.length) {
    // Dex is configured - use ArgoCD's Dex endpoints
    // The issuer for Dex is the ArgoCD server's /api/dex path
    const dexIssuer = new URL('/api/dex', baseUrl).toString();

    return {
      issuer: dexIssuer,
      // ArgoCD CLI uses 'argo-cd-cli' as the client ID for Dex
      clientID: 'argo-cd-cli',
      scopes: ['openid', 'profile', 'email', 'groups', 'federated:id', 'offline_access'],
      // PKCE is always enabled for Dex CLI authentication
      enablePKCEAuthentication: true,
      useDex: true,
      argocdBaseUrl: baseUrl
    };
  }

  // Check for direct OIDC configuration
  if (!settings.oidcConfig) {
    throw new SSONotConfiguredError(
      'SSO is not configured on this ArgoCD server. Neither oidcConfig nor dexConfig is present.'
    );
  }

  const { oidcConfig } = settings;

  if (!oidcConfig.issuer) {
    throw new SSONotConfiguredError('OIDC issuer is not configured on this ArgoCD server.');
  }

  if (!oidcConfig.clientID && !oidcConfig.cliClientID) {
    throw new SSONotConfiguredError(
      'OIDC clientID is not configured on this ArgoCD server. Either clientID or cliClientID must be set.'
    );
  }

  return {
    issuer: oidcConfig.issuer,
    clientID: oidcConfig.cliClientID || oidcConfig.clientID || '',
    cliClientID: oidcConfig.cliClientID,
    scopes: oidcConfig.scopes || ['openid', 'profile', 'email', 'groups'],
    enablePKCEAuthentication: oidcConfig.enablePKCEAuthentication ?? false,
    useDex: false
  };
}

/**
 * Fetch OIDC provider metadata from the well-known endpoint
 * For Dex, constructs the metadata from the ArgoCD server URL
 */
export async function fetchOIDCProviderMetadata(
  oidcConfig: OIDCConfig
): Promise<OIDCProviderMetadata> {
  if (oidcConfig.useDex && oidcConfig.argocdBaseUrl) {
    // For Dex, construct the metadata directly since the endpoints are known
    const baseUrl = oidcConfig.argocdBaseUrl;
    return {
      issuer: new URL('/api/dex', baseUrl).toString(),
      authorization_endpoint: new URL('/api/dex/auth', baseUrl).toString(),
      token_endpoint: new URL('/api/dex/token', baseUrl).toString(),
      userinfo_endpoint: new URL('/api/dex/userinfo', baseUrl).toString(),
      scopes_supported: ['openid', 'profile', 'email', 'groups', 'federated:id', 'offline_access'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256']
    };
  }

  // For external OIDC providers, fetch from well-known endpoint
  const wellKnownUrl = new URL('/.well-known/openid-configuration', oidcConfig.issuer);
  const response = await fetch(wellKnownUrl.toString(), {
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OIDC provider metadata from ${wellKnownUrl}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as OIDCProviderMetadata;
}
