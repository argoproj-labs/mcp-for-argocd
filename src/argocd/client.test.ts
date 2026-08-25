import assert from 'node:assert/strict';
import { test, TestContext } from 'node:test';
import { ArgoCDClient } from './client.js';

// These tests exercise the token-hygiene of tool responses: list/get calls must
// strip the fields that dominate payload size (inline Helm values, comparedTo,
// managedFields, history, operation sync results, cluster apiVersions/config),
// `search` must actually filter (ArgoCD's API has no such param — it must be
// applied client-side, never forwarded), and an unqualified list call must be
// bounded by a default limit. fetch is mocked, so tests are hermetic.

const BASE_URL = 'https://argocd.example.com';
const HELM_VALUES = 'replicaCount: 3\n' + 'x: y\n'.repeat(2000);

// A raw Application as ArgoCD returns it, with all the heavy fields present.
const rawApp = (name: string) => ({
  metadata: {
    name,
    namespace: 'argocd',
    labels: { team: 'cloud' },
    creationTimestamp: '2026-01-01T00:00:00Z',
    managedFields: [{ manager: 'argocd-controller', operation: 'Update' }]
  },
  spec: {
    project: 'default',
    source: {
      repoURL: 'https://git.example.com/deploy.git',
      path: `apps/${name}`,
      targetRevision: 'HEAD',
      helm: { values: HELM_VALUES }
    },
    destination: { server: 'https://kubernetes.default.svc', namespace: name }
  },
  status: {
    sync: {
      status: 'Synced',
      revision: 'abc123',
      comparedTo: {
        source: {
          repoURL: 'https://git.example.com/deploy.git',
          helm: { values: HELM_VALUES }
        }
      }
    },
    health: { status: 'Healthy' },
    summary: { images: [`registry.example.com/${name}:1.0.0`] },
    history: [{ revision: 'abc123', deployedAt: '2026-01-01T00:00:00Z' }],
    operationState: {
      phase: 'Succeeded',
      message: 'successfully synced',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      retryCount: 0,
      syncResult: {
        resources: [{ kind: 'Deployment', name, status: 'Synced', message: 'configured' }]
      }
    }
  }
});

const rawCluster = (name: string) => ({
  name,
  server: `https://${name}.example.com`,
  labels: { env: 'prod' },
  config: { tlsClientConfig: { caData: 'Y2EtZGF0YQ=='.repeat(500) } },
  connectionState: { status: 'Successful' },
  info: {
    applicationsCount: 42,
    serverVersion: 'v1.31.0',
    connectionState: { status: 'Successful' },
    cacheInfo: { resourcesCount: 1000 },
    apiVersions: Array.from({ length: 400 }, (_, i) => `group${i}/v1/Kind${i}`)
  }
});

// Mock fetch to return the given payload and capture each requested URL.
const mockFetch = (t: TestContext, payload: unknown): URL[] => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(new URL(input instanceof Request ? input.url : input.toString()));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  return urls;
};

test('listApplications: search filters client-side and is never forwarded upstream', async (t) => {
  const urls = mockFetch(t, {
    items: [rawApp('adroit-svc-us1'), rawApp('adroit-svc-eu1'), rawApp('watashi-app-us1')]
  });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listApplications({ search: 'WATASHI' });

  // Case-insensitive partial match, and totalItems reflects the filtered count.
  assert.equal(result.metadata.totalItems, 1);
  assert.equal(result.metadata.returnedItems, 1);
  assert.equal(result.items[0]?.metadata?.name, 'watashi-app-us1');
  // ArgoCD's API silently ignores unknown params — sending `search` would
  // return the whole fleet while looking bounded. It must never be sent.
  assert.equal(urls[0].searchParams.has('search'), false);
});

test('listApplications: search with no matches returns empty, not the fleet', async (t) => {
  mockFetch(t, { items: [rawApp('adroit-svc-us1'), rawApp('adroit-svc-eu1')] });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listApplications({ search: 'zzz-definitely-no-such-app-zzz' });

  assert.equal(result.metadata.totalItems, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.metadata.hasMore, false);
});

test('listApplications: projects/selector/repo are forwarded as server-side filters', async (t) => {
  const urls = mockFetch(t, { items: [rawApp('a')] });
  const client = new ArgoCDClient(BASE_URL, 'token');

  await client.listApplications({
    projects: ['team-a', 'team-b'],
    selector: 'env=prod',
    repo: 'https://git.example.com/deploy.git'
  });

  // Repeated proto fields are encoded as repeated query params.
  assert.deepEqual(urls[0].searchParams.getAll('projects'), ['team-a', 'team-b']);
  assert.equal(urls[0].searchParams.get('selector'), 'env=prod');
  assert.equal(urls[0].searchParams.get('repo'), 'https://git.example.com/deploy.git');
});

test('listApplications: an unqualified call is bounded by the default limit', async (t) => {
  mockFetch(t, { items: Array.from({ length: 60 }, (_, i) => rawApp(`app-${i}`)) });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listApplications();

  assert.equal(result.metadata.totalItems, 60);
  assert.equal(result.metadata.returnedItems, 50);
  assert.equal(result.metadata.hasMore, true);
});

test('listApplications: strips inline Helm values and sync.comparedTo', async (t) => {
  mockFetch(t, { items: [rawApp('watashi-app-us1')] });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listApplications();
  const serialized = JSON.stringify(result);

  // The two full copies of the Helm values (spec.source.helm.values and
  // status.sync.comparedTo.source.helm.values) must both be gone.
  assert.ok(!serialized.includes('replicaCount'));
  assert.ok(!serialized.includes('comparedTo'));
  assert.ok(!serialized.includes('managedFields'));
  // The fields that identify the app survive.
  const item = result.items[0];
  assert.ok(item && 'spec' in item);
  assert.equal(item.spec.source?.repoURL, 'https://git.example.com/deploy.git');
  assert.equal(item.spec.source?.path, 'apps/watashi-app-us1');
  assert.equal(item.status.sync?.status, 'Synced');
  assert.equal(item.status.sync?.revision, 'abc123');
  assert.equal(item.status.health?.status, 'Healthy');
  // One stripped app must be a fraction of its raw ~11k-char size.
  assert.ok(serialized.length < 1500, `stripped item too large: ${serialized.length} chars`);
});

test('listApplications: detail "name" returns minimal entries', async (t) => {
  mockFetch(t, { items: [rawApp('watashi-app-us1')] });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listApplications({ detail: 'name' });

  assert.deepEqual(result.items[0], {
    name: 'watashi-app-us1',
    namespace: 'argocd',
    project: 'default',
    syncStatus: 'Synced',
    healthStatus: 'Healthy'
  });
});

test('getApplication: strips managedFields, history, operation detail, and comparedTo by default', async (t) => {
  mockFetch(t, rawApp('watashi-app-us1'));
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.getApplication('watashi-app-us1');
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes('managedFields'));
  assert.ok(!serialized.includes('"history"'));
  assert.ok(!serialized.includes('comparedTo'));
  assert.ok(!serialized.includes('syncResult'));
  // The operation verdict survives the collapse…
  assert.equal(result.status?.operationState?.phase, 'Succeeded');
  assert.equal(result.status?.operationState?.message, 'successfully synced');
  // …and spec is untouched: this is where the (single) copy of the Helm
  // values legitimately lives.
  assert.equal(result.spec?.source?.helm?.values, HELM_VALUES);
});

test('getApplication: includeHistory / includeOperationState opt back in', async (t) => {
  mockFetch(t, rawApp('watashi-app-us1'));
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.getApplication('watashi-app-us1', undefined, {
    includeHistory: true,
    includeOperationState: true
  });

  assert.equal(result.status?.history?.length, 1);
  assert.equal(result.status?.operationState?.syncResult?.resources?.length, 1);
});

test('create/update/syncApplication return the same summary as getApplication', async (t) => {
  // These write endpoints respond with the full Application — the same object
  // get_application strips, and otherwise the largest payload a write could
  // return. A successful write must never be the response that overflows the
  // caller's context.
  const urls = mockFetch(t, rawApp('watashi-app-us1'));
  const client = new ArgoCDClient(BASE_URL, 'token');
  const app = rawApp('watashi-app-us1') as Parameters<typeof client.createApplication>[0];

  const results = [
    await client.createApplication(app),
    await client.updateApplication('watashi-app-us1', app),
    await client.syncApplication('watashi-app-us1', { prune: true })
  ];

  assert.equal(urls.length, 3);
  for (const result of results) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('managedFields'));
    assert.ok(!serialized.includes('"history"'));
    assert.ok(!serialized.includes('comparedTo'));
    assert.ok(!serialized.includes('syncResult'));
    // The operation verdict and the untouched spec survive, as for get_application.
    assert.equal(result.status?.operationState?.phase, 'Succeeded');
    assert.equal(result.spec?.source?.helm?.values, HELM_VALUES);
  }
});

test('listClusters: strips config and info.apiVersions, keeps the summary', async (t) => {
  mockFetch(t, { items: [rawCluster('us1'), rawCluster('eu1')] });
  const client = new ArgoCDClient(BASE_URL, 'token');

  const result = await client.listClusters();
  const serialized = JSON.stringify(result);

  assert.ok(!serialized.includes('apiVersions'));
  assert.ok(!serialized.includes('tlsClientConfig'));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, 'us1');
  assert.equal(result.items[0].server, 'https://us1.example.com');
  assert.equal(result.items[0].connectionState?.status, 'Successful');
  assert.equal(result.items[0].info?.applicationsCount, 42);
  assert.equal(result.items[0].info?.serverVersion, 'v1.31.0');
  // Two stripped clusters must be a fraction of their raw ~15k-char size.
  assert.ok(serialized.length < 1500, `stripped clusters too large: ${serialized.length} chars`);
});
