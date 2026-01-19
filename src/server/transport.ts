import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logging/logging.js';
import { createServer } from './server.js';
import { parseArgoCDConfig, ArgoCDConfig } from '../config/index.js';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const connectStdioTransport = () => {
  const configJson = process.env.ARGOCD_CONFIG_JSON;
  const argocdConfig = parseArgoCDConfig(
    process.env.ARGOCD_BASE_URL,
    process.env.ARGOCD_API_TOKEN,
    configJson
  );

  const server = createServer({ argocdConfig });

  logger.info('Connecting to stdio transport');
  logger.info(`Configured ArgoCD instances: ${argocdConfig.instances.map((i) => i.id).join(', ')}`);
  server.connect(new StdioServerTransport());
};

export const connectSSETransport = (port: number) => {
  const app = express();
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get('/sse', async (req, res) => {
    const configJson = req.headers['x-argocd-config-json'] as string | undefined;
    const argocdConfig = parseArgoCDConfig(
      req.headers['x-argocd-base-url'] as string,
      req.headers['x-argocd-api-token'] as string,
      configJson
    );

    const server = createServer({ argocdConfig });

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
      const configJson =
        (req.headers['x-argocd-config-json'] as string | undefined) ||
        process.env.ARGOCD_CONFIG_JSON;
      const argocdBaseUrl =
        (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL;
      const argocdApiToken =
        (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN;

      let argocdConfig: ArgoCDConfig;
      try {
        argocdConfig = parseArgoCDConfig(argocdBaseUrl, argocdApiToken, configJson);
      } catch (error) {
        res
          .status(400)
          .send(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
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

      const server = createServer({ argocdConfig });

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
