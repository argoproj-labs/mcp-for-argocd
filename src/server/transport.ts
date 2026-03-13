import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer } from './server.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

type ServerInfo = Parameters<typeof createServer>[0];
type HttpTransportOptions = {
  stateless?: boolean;
};

const getHeaderValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const getServerInfo = (req: express.Request): ServerInfo => {
  const argocdBaseUrl = getHeaderValue(req.headers['x-argocd-base-url']) || '';
  const argocdApiToken = getHeaderValue(req.headers['x-argocd-api-token']) || '';

  return {
    argocdBaseUrl: argocdBaseUrl || process.env.ARGOCD_BASE_URL || '',
    argocdApiToken: argocdApiToken || process.env.ARGOCD_API_TOKEN || ''
  };
};

const hasCompleteServerInfo = ({ argocdBaseUrl, argocdApiToken }: ServerInfo) =>
  argocdBaseUrl !== '' && argocdApiToken !== '';

const missingServerInfoMessage =
  'x-argocd-base-url and x-argocd-api-token must be provided in headers or environment.';
const missingStatelessServerInfoMessage =
  'x-argocd-base-url and x-argocd-api-token must be provided in headers or environment for stateless HTTP mode.';

const getMissingStatelessTransportMessage =
  'Bad Request: No stateless transport found for the provided Argo CD configuration. Send initialize first.';

const getStatelessTransportKey = ({ argocdBaseUrl, argocdApiToken }: ServerInfo) =>
  `${argocdBaseUrl}\n${argocdApiToken}`;

const createHttpServerTransport = async (
  serverInfo: ServerInfo,
  options: {
    sessionIdGenerator: (() => string) | undefined;
    onsessioninitialized?: (sessionId: string) => void;
    onclose?: () => void;
  }
) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: options.sessionIdGenerator,
    onsessioninitialized: options.onsessioninitialized
  });

  transport.onclose = options.onclose;

  const server = createServer(serverInfo);
  await server.connect(transport);

  return transport;
};

const getOrCreateStatelessHttpTransport = async (
  statelessHttpTransports: { [authKey: string]: StreamableHTTPServerTransport },
  serverInfo: ServerInfo
) => {
  const authKey = getStatelessTransportKey(serverInfo);
  let transport = statelessHttpTransports[authKey];

  if (!transport) {
    transport = await createHttpServerTransport(serverInfo, {
      sessionIdGenerator: undefined,
      onclose: () => {
        delete statelessHttpTransports[authKey];
      }
    });
    statelessHttpTransports[authKey] = transport;
  }

  return transport;
};

export const connectStdioTransport = () => {
  const server = createServer({
    argocdBaseUrl: process.env.ARGOCD_BASE_URL || '',
    argocdApiToken: process.env.ARGOCD_API_TOKEN || ''
  });

  logger.info('Connecting to stdio transport');
  server.connect(new StdioServerTransport());
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

export const connectHttpTransport = (port: number, options: HttpTransportOptions = {}) => {
  const app = express();
  app.use(express.json());

  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  const statelessHttpTransports: { [authKey: string]: StreamableHTTPServerTransport } = {};

  app.post('/mcp', async (req, res) => {
    const sessionIdFromHeader = getHeaderValue(req.headers['mcp-session-id']);
    const serverInfo = getServerInfo(req);
    let transport: StreamableHTTPServerTransport;

    if (sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
      transport = httpTransports[sessionIdFromHeader];
    } else if (options.stateless) {
      if (!hasCompleteServerInfo(serverInfo)) {
        res.status(400).send(missingStatelessServerInfoMessage);
        return;
      }

      if (isInitializeRequest(req.body)) {
        transport = await getOrCreateStatelessHttpTransport(statelessHttpTransports, serverInfo);
      } else {
        transport = statelessHttpTransports[getStatelessTransportKey(serverInfo)];
        if (!transport) {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: getMissingStatelessTransportMessage
            },
            id: req.body?.id !== undefined ? req.body.id : null
          });
          return;
        }
      }
    } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
      if (!hasCompleteServerInfo(serverInfo)) {
        res.status(400).send(missingServerInfoMessage);
        return;
      }

      transport = await createHttpServerTransport(serverInfo, {
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpTransports[newSessionId] = transport;
        },
        onclose: () => {
          if (transport.sessionId) {
            delete httpTransports[transport.sessionId];
          }
        }
      });
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
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);
    if (sessionId && httpTransports[sessionId]) {
      const transport = httpTransports[sessionId];
      await transport.handleRequest(req, res);
      return;
    }

    const serverInfo = getServerInfo(req);
    if (options.stateless) {
      if (!hasCompleteServerInfo(serverInfo)) {
        res.status(400).send(missingStatelessServerInfoMessage);
        return;
      }

      const transport = statelessHttpTransports[getStatelessTransportKey(serverInfo)];

      if (!transport) {
        res.status(400).send(getMissingStatelessTransportMessage);
        return;
      }

      await transport.handleRequest(req, res);
      return;
    }

    if (!sessionId || !httpTransports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  logger.info(`Connecting to Http Stream transport on port: ${port}`);
  app.listen(port);
};
