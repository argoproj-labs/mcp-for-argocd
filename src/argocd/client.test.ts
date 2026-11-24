import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ArgoCDClient } from './client.js';

const BASE_URL = 'https://argocd.example.com';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Replaces global fetch and records the requested URLs.
const stubFetch = (body: unknown) => {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: URL) => {
    urls.push(new URL(input.toString()));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return urls;
};

const makeApp = (name: string) => ({
  metadata: { name, namespace: 'argocd', labels: { a: 'b' }, creationTimestamp: 't' },
  spec: { project: 'default', source: { repoURL: 'r' }, destination: { server: 's' } },
  status: {
    sync: { status: 'Synced', revision: 'abc', comparedTo: { source: { repoURL: 'r' } } },
    health: { status: 'Healthy' },
    summary: { images: ['img'] },
    resources: [{ kind: 'Pod' }]
  }
});

test('listApplications requests only the needed fields', async () => {
  const urls = stubFetch({ items: [] });
  await new ArgoCDClient(BASE_URL, 'token').listApplications();

  assert.equal(urls.length, 1);
  assert.equal(urls[0].pathname, '/api/v1/applications');
  assert.equal(urls[0].searchParams.has('search'), false);
  assert.equal(
    urls[0].searchParams.get('fields'),
    [
      'items.metadata.name',
      'items.metadata.namespace',
      'items.metadata.labels',
      'items.metadata.creationTimestamp',
      'items.spec',
      'items.status.sync.status',
      'items.status.sync.revision',
      'items.status.health',
      'items.status.summary'
    ].join(',')
  );
  // Sending a spec sub-key together with `items.spec` breaks Argo CD 3.5.
  const fields = urls[0].searchParams.get('fields')!.split(',');
  assert.equal(
    fields.some((f) => f.startsWith('items.spec.')),
    false
  );
});

test('listApplications strips and paginates a full-object response', async () => {
  stubFetch({
    metadata: { resourceVersion: '1' },
    items: [makeApp('a'), makeApp('b'), makeApp('c')]
  });
  const result = await new ArgoCDClient(BASE_URL, 'token').listApplications({
    limit: 2,
    offset: 1
  });

  assert.deepEqual(
    result.items.map((i) => i.metadata.name),
    ['b', 'c']
  );
  assert.deepEqual(Object.keys(result.items[0].status).sort(), ['health', 'summary', 'sync']);
  assert.deepEqual(result.metadata, {
    resourceVersion: '1',
    totalItems: 3,
    returnedItems: 2,
    hasMore: false
  });
});
