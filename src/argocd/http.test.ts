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
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
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

test('HttpClient.getStream flushes trailing NDJSON line without newline and surfaces stream errors', async () => {
  const stub = await startStubArgoCD((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.includes('/stream-err/')) {
      res.end(JSON.stringify({ error: { code: 7, message: 'permission denied' } }));
      return;
    }
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

    await assert.rejects(
      () => client.getApplicationLogs('stream-err'),
      (err) =>
        err instanceof ArgoCDApiError &&
        err.argoCode === 7 &&
        err.message.includes('permission denied')
    );
  } finally {
    await stub.close();
  }
});
