import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer, createStatelessServer } from './server.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { resolveServerInfo, runWithServerInfo, type ServerInfo } from './request-context.js';

type HttpTransportOptions = {
  stateless?: boolean;
};

const getHeaderValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const getServerInfo = (req: express.Request): ServerInfo => {
  const argocdBaseUrl = getHeaderValue(req.headers['x-argocd-base-url']) || '';
  const argocdApiToken = getHeaderValue(req.headers['x-argocd-api-token']) || '';

  return resolveServerInfo({ argocdBaseUrl, argocdApiToken });
};

export const connectStdioTransport = () => {
  const server = createServer(resolveServerInfo());

  logger.info('Connecting to stdio transport');
  server.connect(new StdioServerTransport());
};

export const connectSSETransport = (port: number) => {
  const app = express();
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get('/sse', async (req, res) => {
    const server = createServer(getServerInfo(req));

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
  let statelessHttpTransport: StreamableHTTPServerTransport | undefined;

  const getStatelessHttpTransport = async () => {
    if (!statelessHttpTransport) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      const server = createStatelessServer();
      await server.connect(transport);
      statelessHttpTransport = transport;
    }

    return statelessHttpTransport;
  };

  app.post('/mcp', async (req, res) => {
    const sessionIdFromHeader = getHeaderValue(req.headers['mcp-session-id']);

    if (options.stateless) {
      const transport = await getStatelessHttpTransport();
      const serverInfo = getServerInfo(req);
      await runWithServerInfo(serverInfo, async () => {
        await transport.handleRequest(req, res, req.body);
      });
      return;
    } else if (sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
      await httpTransports[sessionIdFromHeader]!.handleRequest(req, res, req.body);
      return;
    } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
      const serverInfo = getServerInfo(req);
      const transport = new StreamableHTTPServerTransport({
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

      const server = createServer(serverInfo);
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      return;
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
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = getHeaderValue(req.headers['mcp-session-id']);
    if (options.stateless) {
      const transport = await getStatelessHttpTransport();
      const serverInfo = getServerInfo(req);
      await runWithServerInfo(serverInfo, async () => {
        await transport.handleRequest(req, res);
      });
      return;
    }

    if (!sessionId || !httpTransports[sessionId]) {
      res
        .status(400)
        .send(
          sessionId
            ? `Invalid or expired session ID: ${sessionId}`
            : 'Invalid or missing session ID'
        );
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
