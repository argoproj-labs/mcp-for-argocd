import { logger } from '../logging/logging.js';
import { updateTokensInConfig } from './argocdConfig.js';
import { decodeJwtPayload } from './jwt.js';
export type { JwtPayload } from './jwt.js';

// Refresh the token this many seconds before it expires
const REFRESH_BEFORE_EXPIRY_SECS = 300;
// How often to check token validity when expiry cannot be determined
const FALLBACK_CHECK_INTERVAL_MS = 60_000;

type TokenRefresherOptions = {
  contextName: string;
  baseUrl: string;
  refreshToken: string;
  // Injected for testing; defaults to the module-level performTokenRefresh
  performRefresh?: (
    baseUrl: string,
    currentToken: string,
    refreshToken: string
  ) => Promise<TokenRefreshResult>;
  // Injected for testing; defaults to updateTokensInConfig
  updateConfig?: (contextName: string, authToken: string, refreshToken?: string) => void;
};

const secondsUntilExpiry = (token: string): number | undefined => {
  const exp = decodeJwtPayload(token)?.exp;
  return exp !== undefined ? exp - Date.now() / 1000 : undefined;
};

type OidcParams = { tokenEndpoint: string; clientId: string };

// Discover the token endpoint and client_id for the token refresh request.
//
// Strategy (matches ArgoCD CLI behaviour):
// 1. Use the JWT `iss` claim as the OIDC issuer and fetch its discovery document.
//    This covers Azure AD, Okta, and any other external OIDC provider.
// 2. Fall back to the ArgoCD server's own discovery document (covers built-in Dex).
// 3. If neither is reachable, fall back to the Dex default endpoint.
//
// The `client_id` is taken from the JWT `aud` claim when available, because
// that is the client registered with the OIDC provider (e.g. the Azure AD app ID).
// For Dex the `aud` is typically `argo-cd-cli`, which is also the right value.
const resolveOidcParams = async (
  baseUrl: string,
  jwtPayload: ReturnType<typeof decodeJwtPayload>
): Promise<OidcParams> => {
  const dexDefault = `${baseUrl}/api/dex/token`;
  const dexClientId = 'argo-cd-cli';

  const aud = jwtPayload?.aud;
  // For multi-audience tokens aud[0] is a best-effort guess — Azure AD may put
  // the resource audience before the client ID. Use --client-id to override if needed.
  const clientId = Array.isArray(aud) ? aud[0] : (aud ?? dexClientId);

  const tryDiscovery = async (issuerUrl: string): Promise<string | undefined> => {
    try {
      const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as { token_endpoint?: string };
        return data.token_endpoint;
      }
    } catch {
      // fall through
    }
    return undefined;
  };

  // 1. Issuer from the JWT itself (Azure AD, Okta, external OIDC)
  if (jwtPayload?.iss) {
    const endpoint = await tryDiscovery(jwtPayload.iss);
    if (endpoint) return { tokenEndpoint: endpoint, clientId };
  }

  // 2. ArgoCD server's discovery document (Dex proxied through ArgoCD)
  const endpoint = await tryDiscovery(baseUrl);
  if (endpoint) return { tokenEndpoint: endpoint, clientId };

  // 3. Hardcoded Dex path
  return { tokenEndpoint: dexDefault, clientId: dexClientId };
};

export type TokenRefreshResult = {
  authToken: string;
  refreshToken?: string;
};

// Perform a one-shot OIDC refresh_token grant and return the new tokens.
// The caller is responsible for persisting and propagating the result.
export const performTokenRefresh = async (
  baseUrl: string,
  currentToken: string,
  refreshToken: string
): Promise<TokenRefreshResult> => {
  const jwtPayload = decodeJwtPayload(currentToken);
  const { tokenEndpoint, clientId } = await resolveOidcParams(baseUrl, jwtPayload);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId
    }).toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };
  // Prefer id_token (contains ArgoCD groups/roles) over access_token
  const authToken = result.id_token ?? result.access_token;
  if (!authToken) {
    throw new Error('Token refresh response did not contain a new token');
  }

  return { authToken, refreshToken: result.refresh_token };
};

export class TokenRefresher {
  private readonly contextName: string;
  private readonly baseUrl: string;
  private refreshToken: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentToken: string | undefined;
  private onTokenRefreshed: ((newToken: string) => void) | undefined;
  private failureCount = 0;
  private static readonly MAX_BACKOFF_MS = 10 * 60 * 1000;
  private readonly performRefreshFn: NonNullable<TokenRefresherOptions['performRefresh']>;
  private readonly updateConfigFn: NonNullable<TokenRefresherOptions['updateConfig']>;

  constructor(options: TokenRefresherOptions) {
    this.contextName = options.contextName;
    this.baseUrl = options.baseUrl;
    this.refreshToken = options.refreshToken;
    this.performRefreshFn = options.performRefresh ?? performTokenRefresh;
    this.updateConfigFn = options.updateConfig ?? updateTokensInConfig;
  }

  public start(currentToken: string, onTokenRefreshed?: (newToken: string) => void): void {
    this.currentToken = currentToken;
    this.onTokenRefreshed = onTokenRefreshed;
    this.scheduleNext();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // Immediately perform a token refresh, cancelling any pending scheduled refresh.
  // Reschedules the next automatic refresh on completion (success or failure).
  // Throws on refresh failure so the caller can surface the error.
  public async forceRefresh(): Promise<void> {
    this.stop();
    logger.info(`Force-refreshing ArgoCD token for context "${this.contextName}"`);
    try {
      await this.executeRefresh();
      logger.info(`Token force-refreshed successfully for context "${this.contextName}"`);
    } finally {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    const token = this.currentToken;
    if (!token) return;

    const secsLeft = secondsUntilExpiry(token);
    if (secsLeft === undefined) {
      // Cannot determine expiry — retry after fallback interval
      this.timer = setTimeout(() => this.scheduleNext(), FALLBACK_CHECK_INTERVAL_MS).unref();
      return;
    }

    const msUntilRefresh = Math.max(0, (secsLeft - REFRESH_BEFORE_EXPIRY_SECS) * 1000);
    logger.info(
      `Token refresh scheduled in ${Math.round(msUntilRefresh / 1000)}s ` +
        `(expires in ${Math.round(secsLeft)}s)`
    );
    this.timer = setTimeout(() => void this.doRefresh(), msUntilRefresh).unref();
  }

  private async doRefresh(): Promise<void> {
    logger.info(`Refreshing ArgoCD token for context "${this.contextName}"`);
    try {
      await this.executeRefresh();
      this.failureCount = 0;
      logger.info(`Token refreshed successfully for context "${this.contextName}"`);
    } catch (err) {
      this.failureCount++;
      const backoffMs = Math.min(
        Math.pow(2, this.failureCount) * 5_000,
        TokenRefresher.MAX_BACKOFF_MS
      );
      logger.error(
        `Token refresh failed for context "${this.contextName}": ${err instanceof Error ? err.message : String(err)}`
      );
      logger.info(
        `Will retry in ${Math.round(backoffMs / 1000)}s (attempt ${this.failureCount})`
      );
      this.timer = setTimeout(() => void this.doRefresh(), backoffMs).unref();
      return;
    }
    this.scheduleNext();
  }

  private async executeRefresh(): Promise<void> {
    const result = await this.performRefreshFn(
      this.baseUrl,
      this.currentToken ?? '',
      this.refreshToken
    );
    if (result.refreshToken) {
      this.refreshToken = result.refreshToken;
    }
    this.currentToken = result.authToken;
    this.updateConfigFn(this.contextName, result.authToken, result.refreshToken);
    this.onTokenRefreshed?.(result.authToken);
  }
}
