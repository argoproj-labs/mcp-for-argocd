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
 */
export async function fetchOIDCSettings(baseUrl: string): Promise<OIDCConfig> {
  const settings = await fetchArgoSettings(baseUrl);

  if (!settings.oidcConfig) {
    throw new SSONotConfiguredError(
      'SSO is not configured on this ArgoCD server. The oidcConfig is missing from server settings.'
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
    enablePKCEAuthentication: oidcConfig.enablePKCEAuthentication ?? false
  };
}

/**
 * Fetch OIDC provider metadata from the well-known endpoint
 */
export async function fetchOIDCProviderMetadata(issuer: string): Promise<OIDCProviderMetadata> {
  const wellKnownUrl = new URL('/.well-known/openid-configuration', issuer);
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
