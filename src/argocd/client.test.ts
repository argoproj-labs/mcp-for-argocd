import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgoCDClient } from './client.js';

test('listApplications filters by name before paginating and summarizing the results', async (t) => {
  const summarizedApps: string[] = [];
  const applications = ['catalog', 'payments-api', 'payments-worker'].map((name) => ({
    metadata: { name },
    spec: {
      get project() {
        summarizedApps.push(name);
        return 'default';
      }
    }
  }));
  const response = new Response();
  t.mock.method(response, 'json', async () => ({
    items: applications,
    metadata: { resourceVersion: '42' }
  }));
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    assert.equal(String(url), 'https://argocd.example/api/v1/applications');
    return response;
  });
  const client = new ArgoCDClient('https://argocd.example', 'test-token');

  const firstPage = await client.listApplications({ search: ' PAY ', limit: 1 });
  assert.deepEqual(
    firstPage.items.map((app) => app.metadata.name),
    ['payments-api']
  );
  assert.deepEqual(firstPage.metadata, {
    resourceVersion: '42',
    totalItems: 2,
    returnedItems: 1,
    hasMore: true
  });
  assert.deepEqual(summarizedApps, ['payments-api']);

  const secondPage = await client.listApplications({ search: ' PAY ', limit: 1, offset: 1 });
  assert.deepEqual(
    secondPage.items.map((app) => app.metadata.name),
    ['payments-worker']
  );
  assert.deepEqual(secondPage.metadata, {
    resourceVersion: '42',
    totalItems: 2,
    returnedItems: 1,
    hasMore: false
  });
  assert.deepEqual(summarizedApps, ['payments-api', 'payments-worker']);
});
