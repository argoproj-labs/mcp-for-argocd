import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { ArgoCDClient } from './client.js';

// Hermetic: a throwaway local HTTP server stands in for ArgoCD.
let server: Server | undefined;

const startArgoCD = async (
  status: number,
  body: unknown
): Promise<{ client: ArgoCDClient; requests: string[] }> => {
  const requests: string[] = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { client: new ArgoCDClient(`http://127.0.0.1:${port}`, 'token'), requests };
};

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

test('getApplicationSyncWindows returns windows and canSync, sending namespace and project', async () => {
  const response = {
    activeWindows: [{ kind: 'deny', schedule: '0 2 * * *', duration: '1h' }],
    assignedWindows: [{ kind: 'deny', schedule: '0 2 * * *', duration: '1h' }],
    canSync: false
  };
  const { client, requests } = await startArgoCD(200, response);

  const result = await client.getApplicationSyncWindows('guestbook', {
    appNamespace: 'argocd',
    project: 'default'
  });

  assert.deepEqual(result, response);
  assert.equal(
    requests[0],
    '/api/v1/applications/guestbook/syncwindows?appNamespace=argocd&project=default'
  );
});

test('getApplicationSyncWindows normalizes an omitted-fields response to empty lists', async () => {
  // ArgoCD drops empty fields, so "no windows" arrives as an object without the arrays.
  const { client } = await startArgoCD(200, { canSync: true });

  const result = await client.getApplicationSyncWindows('guestbook');

  assert.deepEqual(result, { activeWindows: [], assignedWindows: [], canSync: true });
});

test('getAppProjectSyncWindows returns windows', async () => {
  const windows = [{ kind: 'allow', schedule: '0 8 * * 1-5', duration: '8h' }];
  const { client, requests } = await startArgoCD(200, { windows });

  const result = await client.getAppProjectSyncWindows('default');

  assert.deepEqual(result, { windows });
  assert.equal(requests[0], '/api/v1/projects/default/syncwindows');
});

test('getAppProjectSyncWindows normalizes an empty response to an empty list', async () => {
  const { client } = await startArgoCD(200, {});

  assert.deepEqual(await client.getAppProjectSyncWindows('default'), { windows: [] });
});

test('sync window reads fail on an error status instead of reporting no windows', async () => {
  // An unreadable state must never look like "no windows" (and canSync must not default).
  const { client } = await startArgoCD(403, { code: 7, message: 'permission denied' });

  await assert.rejects(client.getAppProjectSyncWindows('default'), /HTTP 403 - permission denied/);
  await assert.rejects(client.getApplicationSyncWindows('guestbook'), /HTTP 403/);
});

test('sync window reads reject a null body on 200 instead of throwing a TypeError', async () => {
  const { client } = await startArgoCD(200, null);

  await assert.rejects(client.getAppProjectSyncWindows('default'), /unexpected empty response/);
  await assert.rejects(client.getApplicationSyncWindows('guestbook'), /unexpected empty response/);
});
