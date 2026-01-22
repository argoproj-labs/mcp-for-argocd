import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer } from './server.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getDefaultServer, loadToken, isTokenExpired } from '../auth/token-store.js';

interface AuthConfig {
  baseUrl: string;
  apiToken: string;
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
    return { baseUrl: envBaseUrl, apiToken: envApiToken };
  }

  // Priority 2: Stored token for specific server
  if (options?.serverUrl) {
    const storedAuth = await loadToken(options.serverUrl);
    if (storedAuth) {
      if (isTokenExpired(storedAuth.token)) {
        logger.warn(
          { serverUrl: options.serverUrl },
          'Stored token is expired. Please run `argocd-mcp login` to re-authenticate.'
        );
        return null;
      }
      logger.info({ serverUrl: options.serverUrl }, 'Using stored authentication token');
      return {
        baseUrl: storedAuth.serverUrl,
        apiToken: storedAuth.token.accessToken
      };
    }
    logger.warn({ serverUrl: options.serverUrl }, 'No stored authentication found for server');
    return null;
  }

  // Priority 3: Default stored token (first stored server)
  const defaultAuth = await getDefaultServer();
  if (defaultAuth) {
    if (isTokenExpired(defaultAuth.token)) {
      logger.warn(
        { serverUrl: defaultAuth.serverUrl },
        'Stored token is expired. Please run `argocd-mcp login` to re-authenticate.'
      );
      return null;
    }
    logger.info({ serverUrl: defaultAuth.serverUrl }, 'Using default stored authentication token');
    return {
      baseUrl: defaultAuth.serverUrl,
      apiToken: defaultAuth.token.accessToken
    };
  }

  return null;
}

export const connectStdioTransport = async () => {
  const auth = await resolveAuth();

  if (!auth) {
    console.error('Error: No authentication configured.');
    console.error('');
    console.error('Please either:');
    console.error('  1. Set ARGOCD_BASE_URL and ARGOCD_API_TOKEN environment variables');
    console.error('  2. Run `argocd-mcp login <server-url>` to authenticate via SSO');
    process.exit(1);
  }

  const server = createServer({
    argocdBaseUrl: auth.baseUrl,
    argocdApiToken: auth.apiToken
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

export const connectHttpTransport = (port: number) => {
  const app = express();
  app.use(express.json());

  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

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

      const server = createServer({
        argocdBaseUrl,
        argocdApiToken
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
