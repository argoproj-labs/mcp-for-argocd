import { createHash } from 'node:crypto';
import { logger } from '../logging/logging.js';

// RFC 8693 token exchange: trade the user's access token, issued to this MCP
// server, for one issued to ArgoCD's OIDC client for the same user. ArgoCD trusts
// a single issuer, so a token for the MCP server is refused there, and the MCP
// authorization spec forbids forwarding it anyway.
//
// The exchanged token is cached until shortly before it expires; one issued
// without expires_in is used for the call that asked for it and not cached. Identity
// providers log every exchange (authentik records it as a login), so exchanging
// per tool call would flood that log; and concurrent calls for the same user token
// share one exchange.

const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

const NETWORK_TIMEOUT_MS = 10_000;

export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

export type TokenExchangeOptions = {
  // Resolved lazily: it comes from the provider's discovery document.
  tokenEndpoint: () => Promise<URL>;
  clientId: string;
  audience: string;
  scope: string;
  fetchImpl?: typeof fetch;
  // Milliseconds since the epoch; injectable for tests.
  now?: () => number;
  // A cached token is replaced this long before it expires, so one that is valid
  // when picked up does not expire in flight or under a skewed clock.
  refreshSkewSeconds?: number;
  maxEntries?: number;
};

type CacheEntry = { token: string; expiresAt: number };
// expiresAt is absent when the provider sent no expires_in (RFC 8693 makes it
// optional): the token is used once and not cached.
type Exchanged = { token: string; expiresAt?: number };

// Cache keys are hashes, so the map holds no user token in a form that could be
// sent anywhere.
const keyOf = (subjectToken: string): string =>
  createHash('sha256').update(subjectToken, 'utf8').digest('hex');

// What reaches the tool caller. Error codes only: an identity provider's
// error_description can be long, and nothing here may echo a token.
const describeFailure = (status: number, code: string | undefined): string => {
  if (status === 403) {
    return (
      'The identity provider refused to issue an ArgoCD token for this user ' +
      '(403: the user is not allowed to use ArgoCD).'
    );
  }
  if (code === 'invalid_grant') {
    return 'The identity provider rejected the token exchange (invalid_grant). Sign in again.';
  }
  return `The identity provider rejected the token exchange (${code ?? `HTTP ${status}`}).`;
};

export class TokenExchanger {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly maxEntries: number;

  constructor(private readonly options: TokenExchangeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.skewMs = (options.refreshSkewSeconds ?? 30) * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  // The ArgoCD token for this user token, exchanged at most once while it is fresh.
  // `user` names who it is for in the log; the token itself is never logged.
  async getToken(subjectToken: string, user = 'unknown user'): Promise<string> {
    const key = keyOf(subjectToken);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.skewMs > this.now()) {
      return cached.token;
    }
    const running = this.inflight.get(key);
    if (running) return running;

    const exchange = this.exchange(subjectToken)
      .then(
        (entry) => {
          if (entry.expiresAt === undefined) {
            logger.info(
              { user, audience: this.options.audience },
              `Exchanged a token for ${user} (audience ${this.options.audience}, no expiry given: not cached)`
            );
            return entry.token;
          }
          this.store(key, { token: entry.token, expiresAt: entry.expiresAt });
          const validFor = Math.round((entry.expiresAt - this.now()) / 1000);
          logger.info(
            { user, audience: this.options.audience, validFor },
            `Exchanged a token for ${user} (audience ${this.options.audience}, valid ${validFor}s)`
          );
          return entry.token;
        },
        (error: unknown) => {
          logger.warn(
            { user, audience: this.options.audience },
            `Token exchange for ${user} failed: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, exchange);
    return exchange;
  }

  // Drop the cached token, e.g. after ArgoCD answered 401 for it. Given the token
  // that was rejected, only if it is still the cached one: concurrent calls that
  // all failed with an old token must not each discard its fresh replacement.
  invalidate(subjectToken: string, rejectedToken?: string): void {
    const key = keyOf(subjectToken);
    if (rejectedToken !== undefined && this.cache.get(key)?.token !== rejectedToken) return;
    this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  private store(key: string, entry: CacheEntry): void {
    if (this.cache.size >= this.maxEntries) {
      const now = this.now();
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k);
      }
    }
    // Still full of live tokens: drop the oldest. Map keeps insertion order.
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private async exchange(subjectToken: string): Promise<Exchanged> {
    const endpoint = await this.options.tokenEndpoint();
    // No `resource` parameter (RFC 8707): authentik refuses an exchange that
    // carries one with invalid_target. The target is named by `audience`.
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
      client_id: this.options.clientId,
      subject_token: subjectToken,
      subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      // Asked for explicitly: left out, a provider may pick another type (the
      // generic jwt one, say), which would then be refused below.
      requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      audience: this.options.audience,
      scope: this.options.scope
    });

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        // A 307/308 would replay the body, subject_token included, to wherever
        // it points. A token endpoint has no reason to redirect.
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json'
        },
        body,
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
      });
    } catch (error) {
      throw new TokenExchangeError(
        `The identity provider could not be reached for the token exchange: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    let payload: Record<string, unknown> | undefined;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const code = typeof payload?.error === 'string' ? payload.error : undefined;
      throw new TokenExchangeError(describeFailure(response.status, code));
    }

    const token = payload?.access_token;
    const expiresIn = payload?.expires_in;
    const tokenType = payload?.token_type;
    const issuedTokenType = payload?.issued_token_type;
    if (typeof token !== 'string' || token === '') {
      throw new TokenExchangeError('The token exchange response carried no access_token.');
    }
    // RFC 8693 2.2.1: token_type "N_A" means the issued token is not an access
    // token, so it must not be sent to ArgoCD as a bearer credential.
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      throw new TokenExchangeError(
        `The token exchange issued a token of type ${
          typeof tokenType === 'string' ? JSON.stringify(tokenType.slice(0, 40)) : 'unknown'
        }, not a Bearer token.`
      );
    }
    // Required by RFC 8693, and authentik has sent it since its first release
    // with token exchange (2026.8).
    if (issuedTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
      throw new TokenExchangeError(
        `The token exchange issued ${
          typeof issuedTokenType === 'string'
            ? `a ${issuedTokenType.slice(0, 80)} token`
            : 'a token without issued_token_type'
        }, not an access token.`
      );
    }
    if (expiresIn === undefined) return { token };
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new TokenExchangeError('The token exchange response carried an unusable expires_in.');
    }
    return { token, expiresAt: this.now() + expiresIn * 1000 };
  }
}
