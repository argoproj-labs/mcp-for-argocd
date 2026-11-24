import type express from 'express';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { isLoopbackAddress } from './security.js';

// OAuth resource-server mode for the http transport.
//
// The MCP client signs the user in at an external authorization server (an
// OpenID Connect provider such as authentik or Keycloak) and presents the access
// token on every request. This server validates it locally against the provider's
// key set and, before calling ArgoCD, exchanges it (RFC 8693) for a token issued
// to ArgoCD's own OIDC client, the only issuer ArgoCD trusts. The user's token is
// never forwarded to ArgoCD as is: the MCP authorization spec forbids passing a
// client's token through to a downstream API.
//
// Everything is configured from the environment, like MCP_AUTH_TOKEN, and setting
// MCP_OAUTH_ISSUER is what switches the mode on.

export const OAUTH_ENV = {
  issuer: 'MCP_OAUTH_ISSUER',
  audience: 'MCP_OAUTH_AUDIENCE',
  publicUrl: 'MCP_PUBLIC_URL',
  scopes: 'MCP_OAUTH_SCOPES',
  exchangeAudience: 'ARGOCD_TOKEN_EXCHANGE_AUDIENCE',
  exchangeScope: 'ARGOCD_TOKEN_EXCHANGE_SCOPE',
  exchangeClientId: 'ARGOCD_TOKEN_EXCHANGE_CLIENT_ID',
  requireAtJwt: 'MCP_OAUTH_REQUIRE_AT_JWT'
} as const;

// What the MCP client asks for when it signs the user in. offline_access gets it a
// refresh token, so the browser does not open again every time the access token
// expires.
const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

// What the exchange asks for. authentik (2026.8), for one, does not carry the scope over
// from the token being exchanged, and ArgoCD's RBAC reads the groups claim that
// comes with `profile`: without it the user would reach ArgoCD with no roles.
const DEFAULT_EXCHANGE_SCOPE = 'openid profile email';

// The transports serve MCP at this path only.
const MCP_PATH = '/mcp';

// Asymmetric algorithms only. A shared-secret (HS*) token could be minted by
// anyone holding the secret, and a key set never carries one.
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384'];

const NETWORK_TIMEOUT_MS = 10_000;

export type OAuthConfig = {
  issuer: string;
  audience: string;
  publicUrl: URL;
  scopes: string[];
  // Require the RFC 9068 access-token header (typ: at+jwt), for providers that
  // set it. Off by default: authentik (2026.8), among others, does not.
  requireAtJwt: boolean;
  exchange: {
    audience: string;
    scope: string;
    clientId: string;
  };
};

type Env = Record<string, string | undefined>;

const valueOf = (env: Env, name: string): string | undefined => {
  const value = env[name];
  if (value === undefined) return undefined;
  // A set-but-empty value is a broken deployment (an unexpanded '${VAR}', a secret
  // key that resolved to nothing), not a request for the default.
  if (value.trim() === '') {
    throw new Error(`${name} is set but empty. Give it a value or unset it.`);
  }
  return value.trim();
};

// https, or plain http to a loopback address for local development. Anything else
// would carry tokens, or the endpoints that validate them, in the clear.
const secureUrl = (name: string, value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not carry credentials, a query or a fragment.`);
  }
  const loopbackHttp = url.protocol === 'http:' && isLoopbackAddress(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`${name} must be an https URL (plain http is accepted on loopback only).`);
  }
  return url;
};

const words = (value: string): string[] => value.split(/\s+/).filter(Boolean);

const booleanOf = (env: Env, name: string): boolean => {
  const value = valueOf(env, name)?.toLowerCase();
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false.`);
};

// Read the OAuth configuration from the environment. Returns undefined when none
// of it is set, and throws on a partial or unusable configuration rather than
// starting with less protection than the operator meant to configure.
export const resolveOAuthConfig = (env: Env = process.env): OAuthConfig | undefined => {
  const names = Object.values(OAUTH_ENV);
  const present = names.filter((name) => env[name] !== undefined);
  if (present.length === 0) return undefined;

  const issuerValue = valueOf(env, OAUTH_ENV.issuer);
  if (!issuerValue) {
    throw new Error(
      `${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set but ${OAUTH_ENV.issuer} ` +
        'is not. Set it to enable OAuth, or unset the rest.'
    );
  }
  const required = [OAUTH_ENV.audience, OAUTH_ENV.publicUrl, OAUTH_ENV.exchangeAudience];
  const missing = required.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`OAuth is enabled by ${OAUTH_ENV.issuer} but ${missing.join(', ')} not set.`);
  }

  // Validated for its scheme only. The exact string is what tokens and the
  // provider's discovery document must carry, trailing slash included, so it is
  // kept as written.
  secureUrl(OAUTH_ENV.issuer, issuerValue);
  const publicUrl = secureUrl(OAUTH_ENV.publicUrl, valueOf(env, OAUTH_ENV.publicUrl)!);
  if (publicUrl.pathname !== MCP_PATH) {
    throw new Error(
      `${OAUTH_ENV.publicUrl} must be the URL clients use for this server's ${MCP_PATH} endpoint, ` +
        `e.g. https://argocd-mcp.example.com${MCP_PATH}; got ${publicUrl.href}. Serving it under ` +
        'a path prefix behind a proxy is not supported.'
    );
  }

  const audience = valueOf(env, OAUTH_ENV.audience)!;
  const scopes = words(valueOf(env, OAUTH_ENV.scopes) ?? DEFAULT_SCOPES.join(' '));
  return {
    issuer: issuerValue,
    audience,
    publicUrl,
    scopes,
    requireAtJwt: booleanOf(env, OAUTH_ENV.requireAtJwt),
    exchange: {
      audience: valueOf(env, OAUTH_ENV.exchangeAudience)!,
      scope: words(valueOf(env, OAUTH_ENV.exchangeScope) ?? DEFAULT_EXCHANGE_SCOPE).join(' '),
      // In authentik (observed with 2026.8) an access token's audience is the
      // client ID it was issued to, and the exchange must be asked for by that client.
      clientId: valueOf(env, OAUTH_ENV.exchangeClientId) ?? audience
    }
  };
};

// The credentials OAuth mode replaces. Any of them alongside it means two
// authentication schemes on one listener, or a static ArgoCD token a caller could
// end up using instead of their own identity.
export const assertNoStaticCredentials = (env: Env = process.env): void => {
  const conflicting = ['MCP_AUTH_TOKEN', 'ARGOCD_API_TOKEN', 'ARGOCD_TOKEN_REGISTRY_PATH'].filter(
    (name) => env[name] !== undefined && env[name]!.trim() !== ''
  );
  if (conflicting.length > 0) {
    throw new Error(
      `OAuth mode (${OAUTH_ENV.issuer}) cannot be combined with ${conflicting.join(', ')}: in OAuth ` +
        'mode every request carries its own user token and ArgoCD is called as that user. Unset ' +
        `${conflicting.length === 1 ? 'it' : 'them'} (a .env file in the working directory counts).`
    );
  }
  if (!env.ARGOCD_BASE_URL?.trim()) {
    throw new Error(
      'OAuth mode needs ARGOCD_BASE_URL: user tokens are only ever sent to that one instance, so ' +
        'neither the x-argocd-base-url header nor the argocdBaseUrl tool argument is honoured.'
    );
  }
  // Every user's ArgoCD token goes there, so the same rule as the other URLs. A
  // path is allowed: ArgoCD may be served under a prefix.
  secureUrl('ARGOCD_BASE_URL', env.ARGOCD_BASE_URL.trim());
};

export type AuthorizationServer = {
  issuer: string;
  jwksUri: URL;
  tokenEndpoint: URL;
};

// OpenID Connect discovery appends to the issuer's path. Resolving
// '/.well-known/...' against the issuer instead would drop a path such as
// authentik's /application/o/<slug>/.
export const discoveryUrl = (issuer: string): string =>
  `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

// Fetch the provider's discovery document once and keep it. A failure is not
// kept, so the next request tries again: the provider being briefly unreachable at
// startup should not need a restart.
export const createDiscovery = (
  issuer: string,
  fetchImpl: typeof fetch = fetch
): (() => Promise<AuthorizationServer>) => {
  let pending: Promise<AuthorizationServer> | undefined;

  const load = async (): Promise<AuthorizationServer> => {
    const url = discoveryUrl(issuer);
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(`OAuth discovery at ${url} answered HTTP ${response.status}`);
    }
    const document = (await response.json()) as Record<string, unknown>;
    // OpenID Connect Discovery 1.0 §4.3: the issuer in the document must be
    // exactly the one it was fetched for. A mismatch is usually a trailing slash.
    if (document.issuer !== issuer) {
      throw new Error(
        `OAuth discovery at ${url} names the issuer ${String(document.issuer)}, not ${issuer}. ` +
          `${OAUTH_ENV.issuer} must match it exactly, trailing slash included.`
      );
    }
    const endpoint = (name: string): URL => {
      const value = document[name];
      if (typeof value !== 'string') {
        throw new Error(`OAuth discovery at ${url} has no ${name}`);
      }
      return secureUrl(`${name} in ${url}`, value);
    };
    return { issuer, jwksUri: endpoint('jwks_uri'), tokenEndpoint: endpoint('token_endpoint') };
  };

  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
};

// Fixed messages: they end up quoted inside a WWW-Authenticate header, where the
// library's own wording (which quotes claim names) would break the syntax.
const describeVerificationFailure = (error: unknown): string => {
  if (error instanceof joseErrors.JWTExpired) return 'The access token has expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'typ') return 'The token is not an access token';
    return error.reason === 'missing'
      ? 'The access token lacks a required claim'
      : 'The access token was not issued for this server';
  }
  return 'The access token is not valid';
};

// What the token itself got wrong. Everything else jose throws (a key set that
// timed out, answered non-200 or was not JSON, which jose reports as a bare
// JOSEError) and anything that is not a jose error at all is the server's problem:
// answering 401 for it would send every client back to sign in against a provider
// that is already failing.
const TOKEN_ERRORS = [
  joseErrors.JWTExpired,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTInvalid,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JOSENotSupported,
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JWKSMultipleMatchingKeys
];
const isTokenError = (error: unknown): boolean =>
  TOKEN_ERRORS.some((type) => error instanceof type);

export type TokenClaims = {
  sub: string;
  email?: string;
  username?: string;
};

// Validate an access token as a JWT signed by the provider: signature against its
// key set, issuer, audience, expiry. Every rejection is an InvalidTokenError, which
// the SDK's requireBearerAuth answers with 401 and a WWW-Authenticate challenge;
// clients refresh on 401 and on nothing else.
export const createTokenVerifier = (
  config: Pick<OAuthConfig, 'issuer' | 'audience'> & Partial<Pick<OAuthConfig, 'requireAtJwt'>>,
  discover: () => Promise<AuthorizationServer>,
  keySet?: (jwksUri: URL) => JWTVerifyGetKey
): OAuthTokenVerifier => {
  let keys: JWTVerifyGetKey | undefined;
  const makeKeySet =
    keySet ??
    ((jwksUri: URL) => createRemoteJWKSet(jwksUri, { timeoutDuration: NETWORK_TIMEOUT_MS }));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let server: AuthorizationServer;
      try {
        server = await discover();
      } catch {
        throw new ServerError('The authorization server could not be reached');
      }
      keys ??= makeKeySet(server.jwksUri);

      let payload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ALLOWED_ALGORITHMS,
          requiredClaims: ['exp', 'sub'],
          // jose accepts application/at+jwt for this too.
          ...(config.requireAtJwt ? { typ: 'at+jwt' } : {})
        }));
      } catch (error) {
        if (!isTokenError(error)) {
          throw new ServerError('The authorization server key set could not be loaded');
        }
        throw new InvalidTokenError(describeVerificationFailure(error));
      }

      // An ID token from the same provider has the same issuer, audience, subject
      // and expiry, and travels more widely (id_token_hint on logout redirects).
      // With requireAtJwt the header settles it (RFC 9068). Otherwise: access
      // tokens carry the granted scope and ID tokens do not, in authentik 2026.8
      // as in most providers, so require it; and Keycloak marks its ID tokens
      // with typ "ID" in the payload.
      if (!config.requireAtJwt && (typeof payload.scope !== 'string' || payload.typ === 'ID')) {
        throw new InvalidTokenError('The token is not an access token');
      }
      const scope = typeof payload.scope === 'string' ? payload.scope : '';
      const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
      const claims: TokenClaims = {
        sub: payload.sub!,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        username:
          typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined
      };
      return {
        token,
        clientId: azp ?? config.audience,
        scopes: words(scope),
        expiresAt: payload.exp,
        extra: claims
      };
    }
  };
};

export const protectedResourceMetadata = (config: OAuthConfig) => ({
  resource: config.publicUrl.href,
  authorization_servers: [config.issuer],
  scopes_supported: config.scopes,
  bearer_methods_supported: ['header'],
  resource_name: 'Argo CD MCP server'
});

// Where the WWW-Authenticate challenge points clients (RFC 9728 §3.1: the
// well-known prefix inserted before the resource's path).
export const protectedResourceMetadataUrl = (config: OAuthConfig): string =>
  getOAuthProtectedResourceMetadataUrl(config.publicUrl);

// RFC 9728 metadata, at the path-suffixed location the challenge names and at the
// bare one that clients without the challenge probe. Public by design: it names the
// authorization server and nothing else, so it is registered before the inbound
// credential check, and readable cross-origin for browser-based clients.
export const registerProtectedResourceMetadata = (
  app: express.Express,
  config: OAuthConfig
): void => {
  const document = protectedResourceMetadata(config);
  const handler: express.RequestHandler = (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(document);
  };
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, handler);
  app.get('/.well-known/oauth-protected-resource', handler);
};

// The subject a session was opened by. Read from the validated token, so a client
// cannot claim one.
export const subjectOf = (auth: AuthInfo | undefined): string | undefined => {
  const sub = (auth?.extra as TokenClaims | undefined)?.sub;
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
};

// Who a request runs as, for the log: the name people recognise, falling back to
// the email and then the subject. Never the token.
export const userOf = (auth: AuthInfo | undefined): string | undefined => {
  const claims = auth?.extra as TokenClaims | undefined;
  return claims?.username ?? claims?.email ?? subjectOf(auth);
};
