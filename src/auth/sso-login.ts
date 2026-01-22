import { fetchOIDCSettings, fetchOIDCProviderMetadata } from './settings.js';
import {
  generateState,
  generatePKCEChallenge,
  buildAuthorizationUrl,
  exchangeCodeForToken
} from './oauth.js';
import { startCallbackServer, getRedirectUri } from './callback-server.js';
import { saveToken } from './token-store.js';
import type { TokenInfo, OIDCConfig, PKCEChallenge } from './types.js';
import { logger } from '../logging/logging.js';

export interface SSOLoginOptions {
  /** Port for the callback server (default: 8085) */
  port?: number;
  /** Open browser automatically (default: true) */
  openBrowser?: boolean;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
}

export interface SSOLoginResult {
  token: TokenInfo;
  oidcConfig: OIDCConfig;
  serverUrl: string;
}

/**
 * Perform the complete SSO login flow
 *
 * 1. Fetch OIDC configuration from ArgoCD server
 * 2. Fetch OIDC provider metadata
 * 3. Start local callback server
 * 4. Build and return/open authorization URL
 * 5. Wait for callback with authorization code
 * 6. Exchange code for tokens
 * 7. Store tokens
 */
export async function performSSOLogin(
  serverUrl: string,
  options: SSOLoginOptions = {}
): Promise<SSOLoginResult> {
  const { port = 8085, openBrowser = true, timeoutMs = 5 * 60 * 1000 } = options;

  logger.info({ serverUrl }, 'Starting SSO login flow');

  // Step 1: Fetch OIDC configuration from ArgoCD
  logger.info('Fetching OIDC configuration from ArgoCD server...');
  const oidcConfig = await fetchOIDCSettings(serverUrl);
  logger.info(
    { issuer: oidcConfig.issuer, clientID: oidcConfig.clientID },
    'OIDC configuration loaded'
  );

  // Step 2: Fetch OIDC provider metadata
  logger.info({ issuer: oidcConfig.issuer }, 'Fetching OIDC provider metadata...');
  const providerMetadata = await fetchOIDCProviderMetadata(oidcConfig.issuer);
  logger.info('OIDC provider metadata loaded');

  // Step 3: Generate state and PKCE challenge
  const state = generateState();
  let pkce: PKCEChallenge | undefined;

  if (oidcConfig.enablePKCEAuthentication) {
    pkce = generatePKCEChallenge();
    logger.info('PKCE challenge generated');
  }

  // Step 4: Build redirect URI and authorization URL
  const redirectUri = getRedirectUri(port);
  const authUrl = buildAuthorizationUrl(providerMetadata, oidcConfig, redirectUri, state, pkce);

  // Step 5: Start callback server
  logger.info({ port }, 'Starting callback server...');
  const callbackPromise = startCallbackServer(port, state, timeoutMs);

  // Step 6: Open browser or print URL
  if (openBrowser) {
    try {
      // Dynamic import of 'open' package
      const open = (await import('open')).default;
      logger.info('Opening browser for authentication...');
      await open(authUrl);
      console.error('\nOpened browser for authentication.');
      console.error('If the browser did not open, please visit this URL manually:\n');
    } catch {
      // If open fails, fall back to printing
      logger.warn('Failed to open browser, printing URL instead');
      console.error('\nPlease open the following URL in your browser to authenticate:\n');
    }
  } else {
    console.error('\nPlease open the following URL in your browser to authenticate:\n');
  }

  console.error(authUrl);
  console.error('\nWaiting for authentication callback...\n');

  // Step 7: Wait for callback
  const { code, shutdown } = await callbackPromise;
  logger.info('Received authorization code');

  // Step 8: Exchange code for tokens
  logger.info('Exchanging authorization code for tokens...');
  const token = await exchangeCodeForToken(providerMetadata, oidcConfig, code, redirectUri, pkce);
  logger.info('Token exchange successful');

  // Step 9: Shutdown callback server
  await shutdown();

  // Step 10: Store token
  logger.info('Storing authentication token...');
  await saveToken(serverUrl, token, oidcConfig);
  logger.info('Authentication token stored');

  console.error('Successfully authenticated!\n');

  return {
    token,
    oidcConfig,
    serverUrl
  };
}
