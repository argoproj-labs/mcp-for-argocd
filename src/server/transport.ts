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
import { login } from '../argocd/http.js';
import {
  applyListenerSecurity,
  resolveListenerSecurity,
  type ListenerSecurityOptions
} from './security.js';

// Load the base-URL -> token registry once at startup from the JSON file at
// ARGOCD_TOKEN_REGISTRY_PATH. Shared across all connections; read-only after
// construction.
const tokenRegistry = tokenRegistryFromEnv();

export const connectStdioTransport = async () => {
  const argocdBaseUrl = process.env.ARGOCD_BASE_URL || '';
  const argocdApiToken = await resolveApiToken(
    argocdBaseUrl,
    process.env.ARGOCD_API_TOKEN || '',
    process.env.ARGOCD_USERNAME || '',
    process.env.ARGOCD_PASSWORD || ''
  );
  const server = createServer({
    argocdBaseUrl,
    argocdApiToken,
    tokenRegistry
  });

  logger.info('Connecting to stdio transport');
  server.connect(new StdioServerTransport());
};

export type TransportOptions = ListenerSecurityOptions;

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

// A username/password credential is exchanged for a session token once here, so
// everywhere downstream still only ever deals with a token (ARGOCD_API_TOKEN's
// shape). Not used when an API token was already supplied — the token wins.
// Requires a base URL, since the login call has to go somewhere.
const resolveApiToken = async (
  argocdBaseUrl: string,
  argocdApiToken: string,
  username: string,
  password: string
): Promise<string> => {
  if (argocdApiToken || !username || !password) return argocdApiToken;
  if (!argocdBaseUrl) {
    throw new Error(
      'ARGOCD_BASE_URL (or x-argocd-base-url) is required to log in with a username and password.'
    );
  }
  return login(argocdBaseUrl, username, password);
};

// Resolve the session-level ArgoCD credentials from headers or env.
//
// The API token is only ever accepted here (x-argocd-api-token header or
// ARGOCD_API_TOKEN env var) — never as a tool-call argument — so the secret
// stays in the transport layer and out of prompts/model context. A
// username/password pair (x-argocd-username/x-argocd-password headers or
// ARGOCD_USERNAME/ARGOCD_PASSWORD env vars) is accepted the same way and
// exchanged for a token via resolveApiToken.
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
const resolveCredentials = async (
  req: express.Request,
  res: express.Response
): Promise<{ argocdBaseUrl: string; argocdApiToken: string } | null> => {
  const argocdBaseUrl =
    (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL || '';
  let argocdApiToken =
    (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN || '';

  const username =
    (req.headers['x-argocd-username'] as string) || process.env.ARGOCD_USERNAME || '';
  const password =
    (req.headers['x-argocd-password'] as string) || process.env.ARGOCD_PASSWORD || '';
  try {
    argocdApiToken = await resolveApiToken(argocdBaseUrl, argocdApiToken, username, password);
  } catch (error) {
    res.status(401).send(error instanceof Error ? error.message : String(error));
    return null;
  }

  if (!argocdApiToken && tokenRegistry.getSize() === 0) {
    res
      .status(400)
      .send(
        'x-argocd-api-token must be provided in the request header (or the ARGOCD_API_TOKEN env var), ' +
          'x-argocd-username/x-argocd-password (or ARGOCD_USERNAME/ARGOCD_PASSWORD) must be provided, ' +
          'or a token registry must be configured via ARGOCD_TOKEN_REGISTRY_PATH.'
      );
    return null;
  }
  return { argocdBaseUrl, argocdApiToken };
};

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
    const credentials = await resolveCredentials(req, res);
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

export const connectHttpTransport = (options: TransportOptions & { stateless?: boolean }) => {
  const security = resolveListenerSecurity(options);
  const { port, stateless = false } = options;
  const app = express();
  registerHealthz(app);
  applyListenerSecurity(app, security);
  // After the security middleware, so malformed JSON returns 401/403 rather than
  // the body parser's 400, which would tell a caller it passed the credential check.
  app.use(express.json());

  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  app.post('/mcp', async (req, res) => {
    const sessionIdFromHeader = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (!stateless && sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
      transport = httpTransports[sessionIdFromHeader];
    } else if (stateless || (!sessionIdFromHeader && isInitializeRequest(req.body))) {
      const credentials = await resolveCredentials(req, res);
      if (!credentials) return;

      transport = new StreamableHTTPServerTransport(
        stateless
          ? { sessionIdGenerator: undefined }
          : {
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (newSessionId) => {
                httpTransports[newSessionId] = transport;
              }
            }
      );

      if (!stateless) {
        transport.onclose = () => {
          if (transport.sessionId) delete httpTransports[transport.sessionId];
        };
      }

      const server = createServer({ ...credentials, tokenRegistry });
      await server.connect(transport);
    } else {
      const errorMsg = sessionIdFromHeader
        ? `Invalid or expired session ID: ${sessionIdFromHeader}`
        : 'Bad Request: Not an initialization request and no valid session ID provided.';
      res.status(400).json({
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
    if (!sessionId || !httpTransports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await httpTransports[sessionId].handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  return listen(
    app,
    security.bindAddress,
    port,
    `Http Stream transport${stateless ? ' (stateless mode)' : ''}`
  );
};
