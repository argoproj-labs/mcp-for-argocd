import { loadToken, saveToken } from './token-store.js';
import { fetchOIDCProviderMetadata, fetchOIDCSettings } from './settings.js';
import { refreshAccessToken } from './oauth.js';
import { logger } from '../logging/logging.js';

export interface TokenRefreshProvider {
  refreshToken(): Promise<string | null>;
}

/**
 * Create a token refresh provider for a server URL.
 * The provider loads stored auth, fetches OIDC metadata, refreshes the token,
 * and saves the new token to the store.
 */
export function createTokenRefreshProvider(serverUrl: string): TokenRefreshProvider {
  return {
    async refreshToken(): Promise<string | null> {
      try {
        // Load stored auth for this server
        const storedAuth = await loadToken(serverUrl);
        if (!storedAuth) {
          logger.debug({ serverUrl }, 'No stored auth found for token refresh');
          return null;
        }

        // Check if we have a refresh token
        if (!storedAuth.token.refreshToken) {
          logger.debug({ serverUrl }, 'No refresh token available');
          return null;
        }

        // Try with stored OIDC config first
        let providerMetadata = await fetchOIDCProviderMetadata(storedAuth.oidcConfig);
        let oidcConfig = storedAuth.oidcConfig;

        logger.info({ serverUrl }, 'Refreshing access token...');

        try {
          const newToken = await refreshAccessToken(
            providerMetadata,
            oidcConfig,
            storedAuth.token.refreshToken
          );
          await saveToken(serverUrl, newToken, oidcConfig);
          logger.info({ serverUrl }, 'Access token refreshed successfully');
          return newToken.accessToken;
        } catch {
          // If refresh fails, try re-fetching OIDC settings from server (config may have changed)
          logger.debug(
            { serverUrl },
            'Refresh with stored config failed, re-fetching OIDC settings...'
          );

          oidcConfig = await fetchOIDCSettings(serverUrl);
          providerMetadata = await fetchOIDCProviderMetadata(oidcConfig);

          const newToken = await refreshAccessToken(
            providerMetadata,
            oidcConfig,
            storedAuth.token.refreshToken
          );
          await saveToken(serverUrl, newToken, oidcConfig);
          logger.info({ serverUrl }, 'Access token refreshed with updated OIDC config');
          return newToken.accessToken;
        }
      } catch (error) {
        logger.error(
          { serverUrl, error: error instanceof Error ? error.message : String(error) },
          'Failed to refresh access token'
        );
        return null;
      }
    }
  };
}
