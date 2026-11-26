import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ArgoCDClient } from './client.js';
import { ArgoCDApiError, PathValidationError } from './errors.js';

const startStubArgoCD = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/argocd`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
};

test('ArgoCDClient preserves reverse-proxy subpath and skips undefined query params', async () => {
  const seenUrls: string[] = [];

  const stub = await startStubArgoCD((req, res) => {
    seenUrls.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: [] }));
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await client.listApplications();
    await client.getApplicationManagedResources('my-app', {
      kind: 'ConfigMap',
      namespace: undefined
    });

    assert.equal(seenUrls[0], '/argocd/api/v1/applications');
    assert.equal(
      seenUrls[1],
      '/argocd/api/v1/applications/my-app/managed-resources?kind=ConfigMap'
    );
  } finally {
    await stub.close();
  }
});

test('ArgoCDClient rejects path traversal locally before dispatching any HTTP request', async () => {
  let requestsReceived = 0;

  const stub = await startStubArgoCD((_req, res) => {
    requestsReceived += 1;
    res.end('{}');
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await assert.rejects(
      () => client.getApplication('../clusters/in-cluster'),
      PathValidationError
    );
    await assert.rejects(() => client.getAppProject('../applications'), PathValidationError);
    await assert.rejects(() => client.getPodLogs('my-app', '../evil-pod'), PathValidationError);
    assert.equal(requestsReceived, 0);
  } finally {
    await stub.close();
  }
});

test('HttpClient surfaces non-2xx JSON and plain-text responses as typed ArgoCDApiError', async () => {
  const stub = await startStubArgoCD((req, res) => {
    if (req.url?.includes('/missing-app')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ code: 5, message: 'applications.argoproj.io "missing-app" not found' })
      );
      return;
    }
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Bad Gateway from upstream proxy');
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await assert.rejects(
      () => client.getApplication('missing-app'),
      (err) =>
        err instanceof ArgoCDApiError &&
        err.status === 404 &&
        err.argoCode === 5 &&
        err.message.includes('missing-app')
    );

    await assert.rejects(
      () => client.listClusters(),
      (err) =>
        err instanceof ArgoCDApiError && err.status === 502 && err.message.includes('Bad Gateway')
    );

    await assert.rejects(
      () => client.getApplicationLogs('missing-app'),
      (err) => err instanceof ArgoCDApiError && err.status === 404
    );
  } finally {
    await stub.close();
  }
});

test('HttpClient.getStream flushes trailing NDJSON line without newline and surfaces RuntimeStreamError before and after first line', async () => {
  const forbiddenPayload = {
    error: {
      grpc_code: 7,
      http_code: 403,
      http_status: 'Forbidden',
      message: 'permission denied: applications, logs, default/demo-app'
    }
  };

  const stub = await startStubArgoCD((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/forbidden-before-line/')) {
      res.statusCode = 403;
      res.end(JSON.stringify(forbiddenPayload));
      return;
    }
    if (req.url?.includes('/forbidden-mid-stream/')) {
      res.statusCode = 200;
      res.write(JSON.stringify({ result: { content: 'line-1' } }) + '\n');
      res.end(JSON.stringify(forbiddenPayload));
      return;
    }
    res.statusCode = 200;
    res.write(JSON.stringify({ result: { content: 'line-1' } }) + '\n');
    // Omit trailing newline to verify final buffer flush
    res.end(JSON.stringify({ result: { content: 'line-2' } }));
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    const logs = await client.getApplicationLogs('demo-app');
    assert.deepEqual(
      logs.map((l) => l.content),
      ['line-1', 'line-2']
    );

    // Non-2xx stream error before first log line (e.g. get_application_workload_logs 403)
    await assert.rejects(
      () =>
        client.getWorkloadLogs(
          'forbidden-before-line',
          'argocd',
          { name: 'web', namespace: 'default', kind: 'Deployment', group: 'apps', version: 'v1' },
          'web'
        ),
      (err) =>
        err instanceof ArgoCDApiError &&
        err.status === 403 &&
        err.argoCode === 7 &&
        err.message.includes('permission denied') &&
        !err.message.includes('[object Object]')
    );

    // Mid-stream RuntimeStreamError after first log line on HTTP 200
    await assert.rejects(
      () => client.getApplicationLogs('forbidden-mid-stream'),
      (err) =>
        err instanceof ArgoCDApiError &&
        err.status === 403 &&
        err.argoCode === 7 &&
        err.message.includes('permission denied')
    );
  } finally {
    await stub.close();
  }
});

test('HttpClient.getStream cancels upstream reader when a mid-stream error occurs before EOF', async () => {
  let resolveClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const stub = await startStubArgoCD((_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.on('close', () => {
      resolveClosed();
    });
    res.write(JSON.stringify({ result: { content: 'line-1' } }) + '\n');
    res.write(
      JSON.stringify({
        error: {
          grpc_code: 7,
          http_code: 403,
          http_status: 'Forbidden',
          message: 'stream permission denied'
        }
      }) + '\n'
    );
    // Intentionally keep the response open without calling res.end()
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await assert.rejects(
      () => client.getApplicationLogs('open-stream-err'),
      (err) =>
        err instanceof ArgoCDApiError &&
        err.status === 403 &&
        err.argoCode === 7 &&
        err.message.includes('stream permission denied')
    );

    await Promise.race([
      upstreamClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('upstream stream was not cancelled before EOF')), 2000)
      )
    ]);
  } finally {
    await stub.close();
  }
});

test('HttpClient rejects unexpected empty 200 bodies while allowing empty bodies where expected', async () => {
  const stub = await startStubArgoCD((req, res) => {
    if (req.method === 'DELETE') {
      res.statusCode = 200;
      res.end('');
      return;
    }
    if (req.method === 'POST' && req.url?.includes('/resource/actions')) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.end('');
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'test-token');
    await assert.rejects(
      () => client.listApplications(),
      (err) => err instanceof ArgoCDApiError && err.status === 200 && err.message.includes('empty')
    );

    const deleted = await client.deleteApplication('demo-app');
    assert.deepEqual(deleted, {});

    const actionResult = await client.runResourceAction(
      'demo-app',
      'argocd',
      { name: 'web', namespace: 'default', kind: 'Deployment', group: 'apps', version: 'v1' },
      'restart'
    );
    assert.deepEqual(actionResult, {});
  } finally {
    await stub.close();
  }
});

test('HttpClient rejects redirects without forwarding Authorization outside basePath', async () => {
  let leakedRequests = 0;

  const stub = await startStubArgoCD((req, res) => {
    if (req.url?.startsWith('/other-service')) {
      leakedRequests += 1;
      res.statusCode = 200;
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    res.statusCode = 302;
    res.setHeader('Location', '/other-service/steal-token');
    res.end();
  });

  try {
    const client = new ArgoCDClient(stub.baseUrl, 'secret-argocd-token');
    await assert.rejects(
      () => client.listApplications(),
      (err) =>
        err instanceof ArgoCDApiError && err.status === 302 && err.message.includes('redirect')
    );
    await assert.rejects(
      () => client.getApplicationLogs('demo-app'),
      (err) =>
        err instanceof ArgoCDApiError && err.status === 302 && err.message.includes('redirect')
    );
    assert.equal(leakedRequests, 0);
  } finally {
    await stub.close();
  }
});
