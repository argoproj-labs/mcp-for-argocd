import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ArgoCDClient, summarizeApplication } from './client.js';
import type { V1alpha1Application } from '../types/argocd-types.js';

const BASE_URL = 'https://argo.example.com';

// Records every request URL and answers each with the same list body.
const installFetch = (items: V1alpha1Application[]) => {
  const requests: URL[] = [];
  mock.method(globalThis, 'fetch', async (url: unknown) => {
    requests.push(new URL(String(url)));
    return new Response(JSON.stringify({ items, metadata: { resourceVersion: '42' } }), {
      status: 200
    });
  });
  return requests;
};

const HELM_VALUES = 'replicaCount: 3\nimage:\n  tag: 1.2.3\n'.repeat(50);

// Mirrors what the API returns for a Helm application: the values block appears
// in spec.source and again in status.sync.comparedTo, alongside the fields the
// list response is expected to drop.
const application = (name: string, overrides: Partial<V1alpha1Application> = {}) =>
  ({
    metadata: {
      name,
      namespace: 'argocd',
      labels: { team: 'payments' },
      creationTimestamp: '2026-01-01T00:00:00Z',
      managedFields: [{ manager: 'argocd-controller', operation: 'Update' }]
    },
    spec: {
      project: 'default',
      source: {
        repoURL: 'https://git.example.com/charts.git',
        path: `apps/${name}`,
        targetRevision: 'main',
        helm: { values: HELM_VALUES, valuesObject: { replicaCount: 3 } }
      },
      destination: { server: 'https://kubernetes.default.svc', namespace: name },
      syncPolicy: { automated: { prune: true } }
    },
    status: {
      sync: {
        status: 'Synced',
        revision: 'abc123',
        comparedTo: {
          source: { repoURL: 'https://git.example.com/charts.git', helm: { values: HELM_VALUES } }
        }
      },
      health: { status: 'Healthy' },
      operationState: { phase: 'Succeeded', message: 'successfully synced' },
      history: [{ revision: 'abc123' }, { revision: 'def456' }],
      resources: [{ kind: 'Deployment', name }],
      summary: { images: ['registry.example.com/app:1.2.3'] }
    },
    ...overrides
  }) as V1alpha1Application;

const FIXTURE = [
  application('payments-api'),
  application('payments-worker'),
  application('argocd-mcp', {
    spec: {
      project: 'platform',
      sources: [
        { repoURL: 'https://git.example.com/mcp.git', path: 'deploy', targetRevision: 'v1' },
        { repoURL: 'https://git.example.com/values.git', ref: 'values' }
      ],
      destination: { name: 'in-cluster', namespace: 'argocd' }
    },
    status: { sync: { status: 'OutOfSync', revisions: ['111aaa', '222bbb'] } }
  })
];

test('search is applied locally and never forwarded to the API', async (t) => {
  const requests = installFetch(FIXTURE);
  t.after(() => mock.restoreAll());
  const client = new ArgoCDClient(BASE_URL, 'tok');

  const result = await client.listApplications({ search: 'PAYMENTS' });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/v1/applications');
  assert.equal(requests[0].search, '');
  assert.deepEqual(
    result.items.map((a) => a.name),
    ['payments-api', 'payments-worker']
  );
  assert.equal(result.metadata.totalItems, 2);
});

test('list items are summaries without Helm values or per-resource detail', async (t) => {
  installFetch(FIXTURE);
  t.after(() => mock.restoreAll());
  const client = new ArgoCDClient(BASE_URL, 'tok');

  const result = await client.listApplications({ search: 'payments-api' });
  const [item] = result.items;

  assert.deepEqual(item, {
    name: 'payments-api',
    namespace: 'argocd',
    project: 'default',
    labels: { team: 'payments' },
    createdAt: '2026-01-01T00:00:00Z',
    source: {
      repoURL: 'https://git.example.com/charts.git',
      path: 'apps/payments-api',
      chart: undefined,
      targetRevision: 'main',
      ref: undefined
    },
    sources: undefined,
    destination: { server: 'https://kubernetes.default.svc', namespace: 'payments-api' },
    sync: { status: 'Synced', revision: 'abc123', revisions: undefined },
    health: { status: 'Healthy', message: undefined },
    operationPhase: 'Succeeded',
    autoSync: true
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('replicaCount'), false);
  assert.equal(serialized.includes('comparedTo'), false);
  assert.equal(serialized.includes('managedFields'), false);
  assert.equal(serialized.includes('history'), false);
  assert.ok(serialized.length < 1000, `summary should be small, got ${serialized.length} bytes`);
});

test('multi-source applications keep every source', () => {
  const summary = summarizeApplication(FIXTURE[2]);

  assert.equal(summary.source, undefined);
  assert.equal(summary.sources?.length, 2);
  assert.equal(summary.sources?.[1].ref, 'values');
  assert.deepEqual(summary.sync, {
    status: 'OutOfSync',
    revision: undefined,
    revisions: ['111aaa', '222bbb']
  });
  assert.equal(summary.autoSync, false);
});

test('pagination counts reflect the filtered set', async (t) => {
  installFetch(FIXTURE);
  t.after(() => mock.restoreAll());
  const client = new ArgoCDClient(BASE_URL, 'tok');

  const first = await client.listApplications({ search: 'payments', limit: 1 });
  assert.deepEqual(
    first.items.map((a) => a.name),
    ['payments-api']
  );
  assert.deepEqual(first.metadata, {
    resourceVersion: '42',
    totalItems: 2,
    returnedItems: 1,
    offset: 0,
    hasMore: true
  });

  const second = await client.listApplications({ search: 'payments', limit: 1, offset: 1 });
  assert.deepEqual(
    second.items.map((a) => a.name),
    ['payments-worker']
  );
  assert.equal(second.metadata.hasMore, false);
});

test('an offset past the end returns an empty page', async (t) => {
  installFetch(FIXTURE);
  t.after(() => mock.restoreAll());
  const client = new ArgoCDClient(BASE_URL, 'tok');

  const result = await client.listApplications({ offset: 10 });

  assert.deepEqual(result.items, []);
  assert.equal(result.metadata.totalItems, 3);
  assert.equal(result.metadata.hasMore, false);
});

test('an empty list body is handled', async (t) => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({}), { status: 200 }));
  t.after(() => mock.restoreAll());
  const client = new ArgoCDClient(BASE_URL, 'tok');

  const result = await client.listApplications();

  assert.deepEqual(result.items, []);
  assert.equal(result.metadata.totalItems, 0);
});
