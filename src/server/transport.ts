import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer } from './server.js';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { tokenRegistryFromEnv } from './tokenRegistry.js';
import {
  applyListenerSecurity,
  resolveListenerSecurity,
  type ListenerSecurityOptions
} from './security.js';
import {
  createDiscovery,
  createTokenVerifier,
  protectedResourceMetadataUrl,
  registerProtectedResourceMetadata,
  subjectOf,
  userOf,
  type AuthorizationServer,
  type OAuthConfig
} from './oauth.js';
import { TokenExchanger } from '../argocd/tokenExchange.js';

// Load the base-URL -> token registry once at startup from the JSON file at
// ARGOCD_TOKEN_REGISTRY_PATH. Shared across all connections; read-only after
// construction.
const tokenRegistry = tokenRegistryFromEnv();

export const connectStdioTransport = () => {
  const server = createServer({
    argocdBaseUrl: process.env.ARGOCD_BASE_URL || '',
    argocdApiToken: process.env.ARGOCD_API_TOKEN || '',
    tokenRegistry
  });

  logger.info('Connecting to stdio transport');
  server.connect(new StdioServerTransport());
};

export type TransportOptions = Omit<ListenerSecurityOptions, 'oauth'>;

// Optional seams for tests: a stand-in authorization server and token endpoint.
export type OAuthDependencies = {
  discover?: () => Promise<AuthorizationServer>;
  fetchImpl?: typeof fetch;
};

// Liveness probe, registered before the security middleware: a kubelet probe
// addresses the pod IP and carries no bearer token. Reports only that we are up.
const registerHealthz = (app: express.Express) => {
  app.get('/healthz', (_, res) => {
    res.status(200).json({ status: 'ok' });
  });
};

// Log the address actually bound, so an operator can see whether the listener is
// loopback-only or exposed. Both handlers hang off events rather than
// app.listen()'s callback, which Express invokes even when the bind fails, with
// server.address() still null.
const listen = (app: express.Express, bindAddress: string, port: number, label: string) => {
  const server = app.listen(port, bindAddress);
  server.on('listening', () => {
    const { address, port: boundPort } = server.address() as AddressInfo;
    logger.info(`${label} listening on ${address}:${boundPort}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error(`${label} could not bind ${bindAddress}:${port}: ${err.code ?? err.message}`);
    process.exit(1);
  });
  return server;
};

// Resolve the session-level ArgoCD credentials from headers or env.
//
// The API token is only ever accepted here (x-argocd-api-token header or
// ARGOCD_API_TOKEN env var) — never as a tool-call argument — so the secret
// stays in the transport layer and out of prompts/model context.
//
// The token is normally MANDATORY and the connection is rejected when it is
// missing. The exception is when a token registry (ARGOCD_TOKEN_REGISTRY_PATH)
// is configured: the per-call base URL can then resolve its token from the
// registry, so a tokenless connection is allowed.
//
// The base URL is optional at this level: when it is absent, callers may supply
// it per call via the argocdBaseUrl tool argument.
//
// These are outbound credentials only. Inbound authorization is the listener's
// job (MCP_AUTH_TOKEN, see security.ts).
const resolveCredentials = (
  req: express.Request,
  res: express.Response
): { argocdBaseUrl: string; argocdApiToken: string } | null => {
  const argocdBaseUrl =
    (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL || '';
  const argocdApiToken =
    (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN || '';
  if (!argocdApiToken && tokenRegistry.getSize() === 0) {
    res
      .status(400)
      .send(
        'x-argocd-api-token must be provided in the request header (or the ARGOCD_API_TOKEN env var), ' +
          'or a token registry must be configured via ARGOCD_TOKEN_REGISTRY_PATH.'
      );
    return null;
  }
  return { argocdBaseUrl, argocdApiToken };
};

// OAuth mode: the caller is identified by the validated token, and ArgoCD is
// called as that caller. Neither the base URL nor a token is taken from headers:
// a header-supplied base URL would send the user's identity wherever the header
// says.
const resolveOAuthCredentials = (): { argocdBaseUrl: string; argocdApiToken: string } => ({
  argocdBaseUrl: process.env.ARGOCD_BASE_URL || '',
  argocdApiToken: ''
});

export const connectSSETransport = (options: TransportOptions) => {
  const security = resolveListenerSecurity(options);
  const { port } = options;
  const app = express();
  registerHealthz(app);
  applyListenerSecurity(app, security);
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get('/sse', async (req, res) => {
    // Same credential requirement as the http transport. Without it the handler
    // built an McpServer with empty credentials and held it until the socket
    // closed, one per connection.
    const credentials = resolveCredentials(req, res);
    if (!credentials) return;
    const server = createServer({ ...credentials, tokenRegistry });

    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => {
      delete transports[transport.sessionId];
    });
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send(`No transport found for sessionId: ${sessionId}`);
    }
  });

  return listen(app, security.bindAddress, port, 'SSE transport');
};

// Wire OAuth mode: discovery (fetched once, retried on failure), the token
// verifier the bearer middleware calls, and the exchanger that turns a user token
// into an ArgoCD one.
const setUpOAuth = (oauth: OAuthConfig, deps: OAuthDependencies = {}) => {
  const discover = deps.discover ?? createDiscovery(oauth.issuer, deps.fetchImpl);
  const verifier = createTokenVerifier(oauth, discover);
  const exchanger = new TokenExchanger({
    tokenEndpoint: async () => (await discover()).tokenEndpoint,
    clientId: oauth.exchange.clientId,
    audience: oauth.exchange.audience,
    scope: oauth.exchange.scope,
    fetchImpl: deps.fetchImpl
  });
  // Surface a wrong issuer or an unreachable provider in the log at startup
  // instead of on the first request. Not fatal: the next request retries.
  discover().then(
    (server) => logger.info(`OAuth: tokens from ${server.issuer} are accepted`),
    (err: unknown) =>
      logger.error(`OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}`)
  );
  return {
    listener: { verifier, resourceMetadataUrl: protectedResourceMetadataUrl(oauth) },
    exchanger
  };
};

type HttpSession = {
  transport: StreamableHTTPServerTransport;
  // OAuth mode: the subject that opened the session. A session ID is a routing
  // handle, not a credential, so another user presenting it gets no access to it.
  owner?: string;
};

export const connectHttpTransport = (
  options: TransportOptions & {
    stateless?: boolean;
    jsonResponse?: boolean;
    oauth?: OAuthConfig;
    oauthDependencies?: OAuthDependencies;
  }
) => {
  const { port, stateless = false, jsonResponse = false } = options;
  // In JSON mode the SDK keeps every finished response on a long-lived transport, and
  // closing a session mid-call leaves the pending POST unanswered. Stateless mode
  // builds a fresh transport per request, so neither can happen there.
  if (jsonResponse && !stateless) {
    throw new Error('--json-response requires --stateless.');
  }
  const oauth = options.oauth ? setUpOAuth(options.oauth, options.oauthDependencies) : undefined;
  const security = resolveListenerSecurity({ ...options, oauth: oauth?.listener });
  const app = express();
  registerHealthz(app);
  // Public, and read before signing in, so above the credential check.
  if (options.oauth) registerProtectedResourceMetadata(app, options.oauth);
  applyListenerSecurity(app, security);
  // After the security middleware, so malformed JSON returns 401/403 rather than
  // the body parser's 400, which would tell a caller it passed the credential check.
  app.use(express.json());

  const httpSessions: { [sessionId: string]: HttpSession } = {};

  // OAuth mode: anyone the provider will issue a token to can open sessions, so
  // bound how many one user holds. Opening one more closes that user's oldest
  // (insertion order), which a client that lost track of its session will not miss.
  const MAX_SESSIONS_PER_OWNER = 20;
  const makeRoomFor = (owner: string) => {
    const owned = Object.entries(httpSessions).filter(([, s]) => s.owner === owner);
    for (const [id, session] of owned.slice(
      0,
      Math.max(0, owned.length - MAX_SESSIONS_PER_OWNER + 1)
    )) {
      delete httpSessions[id];
      void session.transport.close();
    }
  };

  // The session for this request, if it exists and belongs to the caller. Another
  // user's session answers exactly like a missing one.
  const sessionFor = (req: express.Request, sessionId: string | undefined) => {
    const session = sessionId ? httpSessions[sessionId] : undefined;
    if (!session) return undefined;
    if (oauth && session.owner !== subjectOf(req.auth)) return undefined;
    return session;
  };

  app.post('/mcp', async (req, res) => {
    const sessionIdFromHeader = req.headers['mcp-session-id'] as string | undefined;
    const existing = stateless ? undefined : sessionFor(req, sessionIdFromHeader);
    let transport: StreamableHTTPServerTransport;

    if (existing) {
      transport = existing.transport;
    } else if (stateless || (!sessionIdFromHeader && isInitializeRequest(req.body))) {
      const credentials = oauth ? resolveOAuthCredentials() : resolveCredentials(req, res);
      if (!credentials) return;
      const owner = oauth ? subjectOf(req.auth) : undefined;
      if (oauth && !owner) {
        // requireBearerAuth has run, and the verifier requires `sub`, so this is
        // not reachable with a valid token. Refuse rather than open an ownerless
        // session.
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Unauthenticated' },
          id: null
        });
        return;
      }

      transport = new StreamableHTTPServerTransport(
        stateless
          ? { sessionIdGenerator: undefined, enableJsonResponse: jsonResponse }
          : {
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                if (owner) {
                  makeRoomFor(owner);
                  logger.info(
                    { session: newSessionId, user: userOf(req.auth) },
                    `Session opened for ${userOf(req.auth)}`
                  );
                }
                httpSessions[newSessionId] = { transport, owner };
              }
            }
      );

      if (!stateless) {
        transport.onclose = () => {
          if (transport.sessionId) delete httpSessions[transport.sessionId];
        };
      }

      const server = createServer({
        ...credentials,
        tokenRegistry,
        tokenExchanger: oauth?.exchanger
      });
      await server.connect(transport);
    } else {
      // MCP session management: 404 for a session ID that is unknown or expired
      // (closed, evicted, or another user's), which tells the client to
      // initialize again; 400 when the ID is missing altogether.
      const errorMsg = sessionIdFromHeader
        ? 'Session not found: it may have expired. Initialize a new session.'
        : 'Bad Request: Not an initialization request and no valid session ID provided.';
      res.status(sessionIdFromHeader ? 404 : 400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: errorMsg },
        id: req.body?.id !== undefined ? req.body.id : null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    if (stateless) {
      res.status(405).send('Method Not Allowed in stateless mode');
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const session = sessionFor(req, sessionId);
    if (!session) {
      res.status(404).send('Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  return listen(
    app,
    security.bindAddress,
    port,
    `Http Stream transport${stateless ? ' (stateless mode)' : ''}${jsonResponse ? ' (json response mode)' : ''}${options.oauth ? ' with OAuth' : ''}`
  );
};
