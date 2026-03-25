import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer } from './server.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getDefaultServer, loadToken, isTokenExpired, saveToken } from '../auth/token-store.js';
import { createTokenRefreshProvider } from '../auth/token-refresh.js';
import { fetchOIDCProviderMetadata } from '../auth/settings.js';
import { refreshAccessToken } from '../auth/oauth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { ArgocdOAuthProvider } from '../auth/mcp-oauth-provider.js';
import { startCallbackServer } from '../auth/mcp-oauth-callback.js';
import type { StoredAuth } from '../auth/types.js';

interface AuthConfig {
  baseUrl: string;
  apiToken: string;
  /** Whether this auth comes from SSO (stored token with refresh capability) */
  isSSOAuth: boolean;
}

/**
 * Attempt to refresh an expired token at startup
 * Returns the new access token if successful, null otherwise
 */
async function tryRefreshExpiredToken(storedAuth: StoredAuth): Promise<string | null> {
  // First, try token refresh if we have a refresh token
  if (storedAuth.token.refreshToken) {
    try {
      logger.info(
        { serverUrl: storedAuth.serverUrl },
        'Token expired, attempting refresh at startup...'
      );

      // Try with stored OIDC config first
      let providerMetadata = await fetchOIDCProviderMetadata(storedAuth.oidcConfig);
      let oidcConfig = storedAuth.oidcConfig;

      try {
        const newToken = await refreshAccessToken(
          providerMetadata,
          oidcConfig,
          storedAuth.token.refreshToken
        );
        await saveToken(storedAuth.serverUrl, newToken, oidcConfig);
        logger.info({ serverUrl: storedAuth.serverUrl }, 'Token refreshed successfully at startup');
        return newToken.accessToken;
      } catch {
        // If refresh fails, try re-fetching OIDC settings from server (config may have changed)
        logger.debug(
          { serverUrl: storedAuth.serverUrl },
          'Refresh with stored config failed, re-fetching OIDC settings...'
        );

        const { fetchOIDCSettings } = await import('../auth/settings.js');
        oidcConfig = await fetchOIDCSettings(storedAuth.serverUrl);
        providerMetadata = await fetchOIDCProviderMetadata(oidcConfig);

        const newToken = await refreshAccessToken(
          providerMetadata,
          oidcConfig,
          storedAuth.token.refreshToken
        );
        await saveToken(storedAuth.serverUrl, newToken, oidcConfig);
        logger.info(
          { serverUrl: storedAuth.serverUrl },
          'Token refreshed successfully with updated OIDC config'
        );
        return newToken.accessToken;
      }
    } catch (error) {
      logger.warn(
        {
          serverUrl: storedAuth.serverUrl,
          error: error instanceof Error ? error.message : String(error)
        },
        'Token refresh failed'
      );
    }
  } else {
    logger.debug(
      { serverUrl: storedAuth.serverUrl },
      'No refresh token available'
    );
  }

  return null;
}

/**
 * Resolve authentication credentials from environment variables or stored tokens
 */
async function resolveAuth(options?: { serverUrl?: string }): Promise<AuthConfig | null> {
  // Priority 1: Environment variables
  const envBaseUrl = process.env.ARGOCD_BASE_URL || '';
  const envApiToken = process.env.ARGOCD_API_TOKEN || '';

  if (envBaseUrl && envApiToken) {
    logger.info('Using authentication from environment variables');
    return { baseUrl: envBaseUrl, apiToken: envApiToken, isSSOAuth: false };
  }

  // Priority 2: Stored token for specific server
  if (options?.serverUrl) {
    const storedAuth = await loadToken(options.serverUrl);
    if (storedAuth) {
      let accessToken = storedAuth.token.accessToken;

      if (isTokenExpired(storedAuth.token)) {
        // Try to refresh the expired token
        const refreshedToken = await tryRefreshExpiredToken(storedAuth);
        if (refreshedToken) {
          accessToken = refreshedToken;
        } else {
          logger.warn(
            { serverUrl: options.serverUrl },
            'Stored token is expired and refresh failed. Please run `argocd-mcp login` to re-authenticate.'
          );
          return null;
        }
      }

      logger.info({ serverUrl: options.serverUrl }, 'Using stored authentication token');
      return {
        baseUrl: storedAuth.serverUrl,
        apiToken: accessToken,
        isSSOAuth: true
      };
    }
    logger.warn({ serverUrl: options.serverUrl }, 'No stored authentication found for server');
    return null;
  }

  // Priority 3: Default stored token (first stored server)
  const defaultAuth = await getDefaultServer();
  if (defaultAuth) {
    let accessToken = defaultAuth.token.accessToken;

    if (isTokenExpired(defaultAuth.token)) {
      // Try to refresh the expired token
      const refreshedToken = await tryRefreshExpiredToken(defaultAuth);
      if (refreshedToken) {
        accessToken = refreshedToken;
      } else {
        logger.warn(
          { serverUrl: defaultAuth.serverUrl },
          'Stored token is expired and refresh failed. Please run `argocd-mcp login` to re-authenticate.'
        );
        return null;
      }
    }

    logger.info({ serverUrl: defaultAuth.serverUrl }, 'Using default stored authentication token');
    return {
      baseUrl: defaultAuth.serverUrl,
      apiToken: accessToken,
      isSSOAuth: true
    };
  }

  return null;
}

export const connectStdioTransport = async () => {
  const auth = await resolveAuth();

  // Start server even without auth - tools will report auth errors gracefully
  const tokenRefreshProvider = auth?.isSSOAuth
    ? createTokenRefreshProvider(auth.baseUrl)
    : undefined;

  const server = createServer({
    argocdBaseUrl: auth?.baseUrl ?? '',
    argocdApiToken: auth?.apiToken ?? '',
    tokenRefreshProvider,
    isAuthenticated: auth !== null
  });

  logger.info('Connecting to stdio transport');
  await server.connect(new StdioServerTransport());
};

export const connectSSETransport = (port: number) => {
  const app = express();
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get('/sse', async (req, res) => {
    const server = createServer({
      argocdBaseUrl: (req.headers['x-argocd-base-url'] as string) || '',
      argocdApiToken: (req.headers['x-argocd-api-token'] as string) || ''
    });

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

  logger.info(`Connecting to SSE transport on port: ${port}`);
  app.listen(port);
};

export const connectHttpTransport = (port: number, options?: {
  serverUrl?: string;
  insecure?: boolean;
  callbackPort?: number;
}) => {
  const app = express();
  app.use(express.json());

  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  if (options?.serverUrl) {
    // OAuth 2.1 mode: MCP clients authenticate via OAuth flow proxied to ArgoCD OIDC
    const callbackPort = options.callbackPort ?? 8085;
    const mcpBaseUrl = `http://localhost:${port}`;
    const provider = new ArgocdOAuthProvider(options.serverUrl, callbackPort, options.insecure);

    // Install OAuth routes (/.well-known/oauth-authorization-server, /authorize, /token, /register)
    app.use(mcpAuthRouter({
      provider,
      issuerUrl: new URL(mcpBaseUrl),
      baseUrl: new URL(mcpBaseUrl),
    }));

    // Start standalone callback server on the Dex-registered port
    startCallbackServer(provider, callbackPort).catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to start OAuth callback server');
      process.exit(1);
    });

    // Protect /mcp with bearer auth
    const bearerAuth = requireBearerAuth({ verifier: provider });

    app.post('/mcp', bearerAuth, async (req, res) => {
      const sessionIdFromHeader = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
        transport = httpTransports[sessionIdFromHeader];
      } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
        // Extract ArgoCD credentials from the verified OAuth token
        const argocdToken = req.auth?.extra?.argocdToken as string;
        const argocdBaseUrl = req.auth?.extra?.argocdBaseUrl as string;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            httpTransports[newSessionId] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete httpTransports[transport.sessionId];
          }
        };

        const server = createServer({
          argocdBaseUrl,
          argocdApiToken: argocdToken,
        });

        await server.connect(transport);
      } else {
        const errorMsg = sessionIdFromHeader
          ? `Invalid or expired session ID: ${sessionIdFromHeader}`
          : 'Bad Request: Not an initialization request and no valid session ID provided.';
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: errorMsg
          },
          id: req.body?.id !== undefined ? req.body.id : null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });

    logger.info(
      { serverUrl: options.serverUrl, port },
      'OAuth 2.1 authentication enabled for HTTP transport'
    );
  } else {
    // Legacy mode: header-based auth
    app.post('/mcp', async (req, res) => {
      const sessionIdFromHeader = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
        transport = httpTransports[sessionIdFromHeader];
      } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
        const argocdBaseUrl =
          (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL || '';
        const argocdApiToken =
          (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN || '';

        if (argocdBaseUrl == '' || argocdApiToken == '') {
          res
            .status(400)
            .send('x-argocd-base-url and x-argocd-api-token must be provided in headers.');
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            httpTransports[newSessionId] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete httpTransports[transport.sessionId];
          }
        };

        // Check if stored auth exists for token refresh capability
        const storedAuth = await loadToken(argocdBaseUrl);
        const tokenRefreshProvider = storedAuth
          ? createTokenRefreshProvider(argocdBaseUrl)
          : undefined;

        const server = createServer({
          argocdBaseUrl,
          argocdApiToken,
          tokenRefreshProvider
        });

        await server.connect(transport);
      } else {
        const errorMsg = sessionIdFromHeader
          ? `Invalid or expired session ID: ${sessionIdFromHeader}`
          : 'Bad Request: Not an initialization request and no valid session ID provided.';
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: errorMsg
          },
          id: req.body?.id !== undefined ? req.body.id : null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });
  }

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !httpTransports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const transport = httpTransports[sessionId];
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  logger.info(`Connecting to Http Stream transport on port: ${port}`);
  app.listen(port);
};
