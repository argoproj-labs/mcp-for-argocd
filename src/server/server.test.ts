import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './server.js';
import { TokenRegistry } from './tokenRegistry.js';
import type { PatchOp } from '../shared/parameters.js';

// These tests exercise the per-call token-resolution boundary in resolveClient
// via the registered tool handlers. The security-critical invariant is:
//
//   the default (session) token is bound to the default base URL ONLY and must
//   never be sent to a caller-supplied base URL.
//
// resolveClient is private, so we drive a real tool handler. When no token can
// be resolved for the requested base URL, the handler returns an error result
// *before* making any HTTP request, so these tests are hermetic (no network).

const DEFAULT_BASE_URL = 'https://argocd.internal.example.com';
const DEFAULT_TOKEN = 'default-secret-token';
const EVIL_BASE_URL = 'https://evil.example.com';
// A legitimately registered second instance (distinct from the default), used to
// prove that the presence of an unrelated registry entry doesn't change how the
// default base URL resolves its token.
const OTHER_BASE_URL = 'https://argocd.other.example.com';

// Invoke a registered tool's handler with the given arguments and return the
// raw CallTool result ({ isError, content: [{ text }] }).
const callTool = async (
  server: ReturnType<typeof createServer>,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ isError?: boolean; content: { text: string }[] }> => {
  // The MCP SDK stores registered tools (with their handlers) on _registeredTools.
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registered[toolName];
  assert.ok(tool, `tool "${toolName}" is registered`);
  // The SDK exposes the tool's registered callback as `handler`.
  assert.equal(typeof tool.handler, 'function', `tool "${toolName}" has a handler`);
  return (await tool.handler(args, {})) as { isError?: boolean; content: { text: string }[] };
};

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map((c) => c.text).join('\n');

test('overridden base URL with no registry entry does NOT receive the default token', async () => {
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: new TokenRegistry()
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });

  // The call must fail to resolve a token (so nothing is ever sent to the
  // attacker host) rather than silently pairing the default token with it.
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
  assert.match(textOf(result), new RegExp(EVIL_BASE_URL));
});

test('overridden base URL with a registry entry uses the registry token, not the default', async () => {
  const registry = new TokenRegistry([{ baseUrl: EVIL_BASE_URL, token: 'registered-token' }]);
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: registry
  });

  // resolveClient should succeed and pair EVIL_BASE_URL with 'registered-token'
  // (not DEFAULT_TOKEN). We assert on the cached client built for this base URL.
  const client = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => unknown;
    }
  ).resolveClient({ argocdBaseUrl: EVIL_BASE_URL }) as { client: { apiToken: string } };

  assert.equal(client.client.apiToken, 'registered-token');
  assert.notEqual(client.client.apiToken, DEFAULT_TOKEN);
});

test('default base URL uses the default token', async () => {
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: new TokenRegistry()
  });

  const client = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => unknown;
    }
  ).resolveClient({ argocdBaseUrl: DEFAULT_BASE_URL }) as { client: { apiToken: string } };

  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('default base URL match is normalized (trailing slash / case)', async () => {
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: new TokenRegistry()
  });

  // Same host, different formatting — must still be treated as the default URL
  // and receive the default token.
  const client = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => unknown;
    }
  ).resolveClient({ argocdBaseUrl: `${DEFAULT_BASE_URL.toUpperCase()}/` }) as {
    client: { apiToken: string };
  };

  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('overriding argocdBaseUrl to the default instance reuses the session token (registry present)', async () => {
  // The README invariant: overriding argocdBaseUrl to the DEFAULT instance
  // (same host, formatting aside) reuses the session token, while pointing it at
  // any OTHER instance requires a registry entry. Here a registry exists with an
  // entry for a *different* registered host; overriding to the default host
  // (differently formatted) must still resolve the default session token, not
  // fail or consult the registry.
  const registry = new TokenRegistry([{ baseUrl: OTHER_BASE_URL, token: 'registered-token' }]);
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: registry
  });

  const client = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => unknown;
    }
  ).resolveClient({ argocdBaseUrl: `${DEFAULT_BASE_URL.toUpperCase()}/` }) as {
    client: { apiToken: string };
  };

  assert.equal(client.client.apiToken, DEFAULT_TOKEN);
});

test('overriding argocdBaseUrl to a different instance with no registry entry sends no request', async () => {
  // The README invariant's failure mode: pointing argocdBaseUrl at an instance
  // that is NOT in the registry must fail with "Missing required ArgoCD API
  // token" before any HTTP request is made — even though a valid default token
  // exists for the default host, it must never be sent to the other host.
  const registry = new TokenRegistry([{ baseUrl: DEFAULT_BASE_URL, token: 'registered-default' }]);
  const server = createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: registry
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
  assert.match(textOf(result), new RegExp(EVIL_BASE_URL));
});

test('with no default token, an overridden URL still resolves only from the registry', async () => {
  // Tokenless session (allowed when a registry is configured). The default token
  // is empty, so even the default URL has no token, and an unregistered override
  // must fail rather than borrow anything.
  const registry = new TokenRegistry([{ baseUrl: DEFAULT_BASE_URL, token: 'registered-default' }]);
  const server = createServer({
    argocdBaseUrl: '',
    argocdApiToken: '',
    tokenRegistry: registry
  });

  const result = await callTool(server, 'list_applications', { argocdBaseUrl: EVIL_BASE_URL });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Missing required ArgoCD API token/);
});

// ---------------------------------------------------------------------------
// set_application_parameters
//
// These tests exercise the wiring between the tool handler and the pure
// functions in shared/parameters.ts — which source is resolved, what patch
// document reaches the client, and what the handler reports about a write it did
// or did not make. The merge rules themselves are covered in
// shared/parameters.test.ts.
//
// Every test stubs the client, so nothing here makes an HTTP request: the tool
// resolves its client through resolveClient, which returns the cached default
// client when the call carries no argocdBaseUrl override, so replacing
// `argocdClient` on the instance is enough.

type PatchCall = { name: string; ops: PatchOp[]; options?: { appNamespace?: string } };
type GetCall = { name: string; namespace?: string };

const stubClient = (
  server: ReturnType<typeof createServer>,
  app: unknown,
  onPatch?: () => void
): { gets: GetCall[]; patches: PatchCall[] } => {
  const gets: GetCall[] = [];
  const patches: PatchCall[] = [];
  (server as unknown as { argocdClient: unknown }).argocdClient = {
    getApplication: async (name: string, namespace?: string) => {
      gets.push({ name, namespace });
      return app;
    },
    patchApplication: async (name: string, ops: PatchOp[], options?: { appNamespace?: string }) => {
      patches.push({ name, ops, options });
      onPatch?.();
      return app;
    }
  };
  return { gets, patches };
};

const paramServer = () =>
  createServer({
    argocdBaseUrl: DEFAULT_BASE_URL,
    argocdApiToken: DEFAULT_TOKEN,
    tokenRegistry: new TokenRegistry()
  });

const setParams = async (server: ReturnType<typeof createServer>, args: Record<string, unknown>) =>
  await callTool(server, 'set_application_parameters', args);

// A key's absence is part of the contract for `reason`, so the whole key set is
// asserted rather than individual fields. A Set compares membership only: the
// order the handler happens to spread them in is not the contract.
const keysOf = (payload: Record<string, unknown>): Set<string> => new Set(Object.keys(payload));

// Catches: the patch not being sent at all; `applied` inverted; autoSyncEnabled
// hardcoded or read from the wrong field; durability omitted or replaced;
// `helm` not forwarded to the merge; the ops being built from the merged source
// on both sides (which would drop the `test` op's read-time value); a renamed or
// missing response key.
test('set_application_parameters upserts a helm parameter, patches once and reports the change', async () => {
  const server = paramServer();
  const { gets, patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      source: {
        repoURL: 'https://git.example.com/a',
        helm: { parameters: [{ name: 'image.tag', value: 'v1' }] }
      },
      syncPolicy: { automated: { prune: true } }
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'image.tag', value: 'v2' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.deepEqual(
    keysOf(payload),
    new Set([
      'dryRun',
      'sourceIndex',
      'autoSyncEnabled',
      'durability',
      'changes',
      'source',
      'applied'
    ])
  );
  assert.equal(payload.applied, true);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.sourceIndex, null);
  assert.equal(payload.autoSyncEnabled, true);
  assert.deepEqual(payload.durability, { durable: true });
  assert.deepEqual(payload.changes, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'image.tag',
      from: { name: 'image.tag', value: 'v1' },
      to: { name: 'image.tag', value: 'v2' }
    }
  ]);
  assert.deepEqual(payload.source, {
    repoURL: 'https://git.example.com/a',
    helm: { parameters: [{ name: 'image.tag', value: 'v2' }] }
  });

  assert.deepEqual(gets, [{ name: 'my-app', namespace: undefined }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].name, 'my-app');
  assert.deepEqual(patches[0].ops, [
    {
      op: 'test',
      path: '/spec/source/helm/parameters',
      value: [{ name: 'image.tag', value: 'v1' }]
    },
    {
      op: 'add',
      path: '/spec/source/helm/parameters',
      value: [{ name: 'image.tag', value: 'v2' }]
    }
  ]);
});

// Catches: dryRun ignored, so a preview writes; `applied` reported true for a
// preview; the merged source withheld from the preview, which is the only thing
// a preview has to offer; autoSyncEnabled hardcoded true.
test('set_application_parameters with dryRun previews the merge and sends no patch', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '2' }] },
    dryRun: true
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, false);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.autoSyncEnabled, false);
  assert.equal(payload.changes.length, 1);
  assert.deepEqual(payload.source, {
    repoURL: 'r',
    helm: { parameters: [{ name: 'a', value: '2' }] }
  });
  assert.match(payload.reason, /dryRun/i);
  assert.equal(patches.length, 0);
});

// Catches: the `changes.length === 0` guard removed. With the guard gone the
// ops-length guard below still suppresses the write, so `applied` and
// `patches.length` alone would not notice — the distinct reason is what does.
test('set_application_parameters skips the write when the values are already set', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '1' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.changes, []);
  assert.match(payload.reason, /no changes/i);
  assert.equal(patches.length, 0);
});

// Catches: the `ops.length === 0` guard removed — an empty patch document sent
// to Argo CD and `applied: true` reported for a change that was never written.
// buildPatchOps returns [] here with a non-empty change list: valuesObject was
// absent at read time and the merge leaves it empty, so the state asked for is
// already the state on the server.
test('set_application_parameters sends no patch when every change resolves to an empty value', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { valuesObject: {} }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, false);
  assert.equal(payload.changes.length, 1);
  assert.equal(payload.changes[0].field, 'helm.valuesObject');
  assert.equal(patches.length, 0);
  // Distinct from the no-changes reason, so neither guard can stand in for the other.
  assert.doesNotMatch(payload.reason, /no changes/i);
  assert.match(payload.reason, /patch/i);
});

// Catches: durability omitted, hardcoded, or built from the wrong object;
// autoSyncEnabled read as Boolean(syncPolicy) rather than of its `automated`
// field — this application has a syncPolicy with no automated block.
test('set_application_parameters reports a non-durable ApplicationSet-generated application', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app', ownerReferences: [{ kind: 'ApplicationSet', name: 'prod-apps' }] },
    spec: { source: { repoURL: 'r' }, syncPolicy: { syncOptions: ['CreateNamespace=true'] } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '1' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.durability.durable, false);
  assert.deepEqual(payload.durability.managedBy, { kind: 'ApplicationSet', name: 'prod-apps' });
  assert.match(payload.durability.note, /ApplicationSet/);
  assert.equal(payload.autoSyncEnabled, false);
  // Non-durable is reported, not refused: the write still happens.
  assert.equal(payload.applied, true);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    {
      op: 'add',
      path: '/spec/source/helm',
      value: { parameters: [{ name: 'a', value: '1' }] }
    }
  ]);
});

// Catches: sourceIndex not forwarded to buildPatchOps (the ops would target
// /spec/source); not forwarded to resolveTargetSource (it would throw the
// multi-source error instead); applicationNamespace not forwarded to
// patchApplication as appNamespace, or not forwarded to getApplication.
test('set_application_parameters targets the requested source of a multi-source application', async () => {
  const server = paramServer();
  const { gets, patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      sources: [
        {
          repoURL: 'https://git.example.com/chart',
          helm: { parameters: [{ name: 'a', value: '1' }] }
        },
        { repoURL: 'https://git.example.com/values' }
      ]
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    applicationNamespace: 'team-a',
    sourceIndex: 1,
    helm: { parameters: [{ name: 'b', value: '2' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.sourceIndex, 1);
  // The second source, not the first: only index 1 has no pre-existing parameters.
  assert.deepEqual(payload.source, {
    repoURL: 'https://git.example.com/values',
    helm: { parameters: [{ name: 'b', value: '2' }] }
  });
  assert.deepEqual(gets, [{ name: 'my-app', namespace: 'team-a' }]);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    {
      op: 'add',
      path: '/spec/sources/1/helm',
      value: { parameters: [{ name: 'b', value: '2' }] }
    }
  ]);
  assert.equal(patches[0].options?.appNamespace, 'team-a');
});

// Catches: sourceIndex handled by truthiness anywhere in the handler — `0` is
// falsy, so `sourceIndex || undefined` or `sourceIndex ? ... : ...` would either
// make resolveTargetSource demand an index it was just given or build the ops
// against /spec/source.
test('set_application_parameters treats sourceIndex 0 as an index, not an omitted argument', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      sources: [
        {
          repoURL: 'https://git.example.com/chart',
          helm: { parameters: [{ name: 'a', value: '1' }] }
        },
        { repoURL: 'https://git.example.com/values' }
      ]
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    sourceIndex: 0,
    helm: { parameters: [{ name: 'a', value: '2' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.sourceIndex, 0);
  assert.equal(payload.source.repoURL, 'https://git.example.com/chart');
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    {
      op: 'test',
      path: '/spec/sources/0/helm/parameters',
      value: [{ name: 'a', value: '1' }]
    },
    {
      op: 'add',
      path: '/spec/sources/0/helm/parameters',
      value: [{ name: 'a', value: '2' }]
    }
  ]);
});

// Catches: `unset` not forwarded to the merge — the parameters would be appended
// to rather than replacing the existing ones, so the source would still hold a
// and b.
test('set_application_parameters applies unset before set, replacing a list in one call', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      source: {
        repoURL: 'r',
        helm: {
          parameters: [
            { name: 'a', value: '1' },
            { name: 'b', value: '2' }
          ]
        }
      }
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    unset: { helm: { parameters: ['a', 'b'] } },
    helm: { parameters: [{ name: 'c', value: '3' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.source.helm.parameters, [{ name: 'c', value: '3' }]);
  assert.deepEqual(
    payload.changes.map((change: { op: string; key: string }) => [change.op, change.key]),
    [
      ['unset', 'a'],
      ['unset', 'b'],
      ['set', 'c']
    ]
  );
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    {
      op: 'test',
      path: '/spec/source/helm/parameters',
      value: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ]
    },
    { op: 'add', path: '/spec/source/helm/parameters', value: [{ name: 'c', value: '3' }] }
  ]);
});

// Catches: `kustomize` not forwarded to the merge, which would leave the change
// list empty and report nothing to apply.
test('set_application_parameters applies kustomize overrides', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', kustomize: { images: ['nginx:1.1'] } } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    kustomize: { images: ['nginx:1.2'], commonLabels: { team: 'a' } }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.source.kustomize, {
    images: ['nginx:1.2'],
    commonLabels: { team: 'a' }
  });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    { op: 'test', path: '/spec/source/kustomize/images', value: ['nginx:1.1'] },
    { op: 'add', path: '/spec/source/kustomize/images', value: ['nginx:1.2'] },
    { op: 'add', path: '/spec/source/kustomize/commonLabels', value: { team: 'a' } }
  ]);
});

// ---------------------------------------------------------------------------
// Single source type
//
// An Argo CD source has one type. A source left holding two non-empty override
// blocks cannot be rendered at all, so on an auto-sync application this write
// would turn a parameter change into a failed sync. Both refusals assert that no
// patch was sent, because a refusal that still writes is the failure mode.

// Catches: the guard dropped, or narrowed to only the both-blocks-in-one-call
// shape. Without it this call writes both blocks and reports applied: true.
test('set_application_parameters refuses to write both a helm and a kustomize block', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r' } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '1' }] },
    kustomize: { images: ['nginx:1.2'] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /helm/);
  assert.match(textOf(result), /kustomize/);
  assert.match(textOf(result), /only have one type/i);
  assert.equal(patches.length, 0);
});

// Catches: the guard reading only the call's arguments instead of the merged
// source. This is the shape reached by accident — a model bumping an image tag on
// a Kustomize application reaches for helm.parameters — and the arguments alone
// look legal.
test('set_application_parameters refuses helm overrides on a source that already has kustomize', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', kustomize: { images: ['nginx:1.1'] } } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'image.tag', value: 'v2' }] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /already has: kustomize/);
  assert.equal(patches.length, 0);
});

// Catches: the guard written as a presence check rather than an emptiness one,
// which would refuse the only call that repairs an application already carrying
// both blocks — unsetting a block's last field leaves `{}` behind, not nothing.
test('set_application_parameters still allows unsetting one block of a source that has both', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      source: {
        repoURL: 'r',
        helm: { parameters: [{ name: 'a', value: '1' }] },
        kustomize: { images: ['nginx:1.1'] }
      }
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    unset: { kustomize: { images: ['nginx'] } }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, true);
  // The kustomize block is emptied, not removed: that is what makes the emptiness
  // check the load-bearing part of the guard.
  assert.deepEqual(payload.source.kustomize, {});
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].ops, [
    { op: 'test', path: '/spec/source/kustomize/images', value: ['nginx:1.1'] },
    { op: 'remove', path: '/spec/source/kustomize/images' }
  ]);
});

// Catches: the same presence-vs-emptiness mutation from the other direction — an
// emptied leftover block must not count as the source's type when the caller sets
// the other one.
test('set_application_parameters allows helm overrides alongside an emptied kustomize block', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: { source: { repoURL: 'r', kustomize: {} } }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '1' }] }
  });

  assert.equal(result.isError, false);
  const payload = JSON.parse(textOf(result));
  assert.equal(payload.applied, true);
  assert.equal(patches.length, 1);
});

// Catches: resolveTargetSource's error swallowed or replaced by a generic
// message, and any write attempted before the source is resolved. The listing is
// asserted because it is what lets a caller retry without a second read.
test('set_application_parameters surfaces the multi-source resolution error', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, {
    metadata: { name: 'my-app' },
    spec: {
      sources: [
        { repoURL: 'https://git.example.com/chart' },
        { repoURL: 'https://git.example.com/values' }
      ]
    }
  });

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '1' }] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /multi-source form/i);
  assert.match(textOf(result), /sourceIndex is required/);
  assert.match(textOf(result), /1: https:\/\/git\.example\.com\/values/);
  assert.equal(patches.length, 0);
});

// Catches: the `!app?.spec` guard removed. getApplication resolves with Argo CD's
// error body rather than throwing, so without the guard the handler dereferences
// it and fails somewhere unrelated with a TypeError that names neither the
// application nor Argo CD's reason.
test('set_application_parameters errors when the application response carries no spec', async () => {
  const server = paramServer();
  const { patches } = stubClient(server, { error: 'application not found', code: 5 });

  const result = await setParams(server, {
    applicationName: 'ghost',
    helm: { parameters: [{ name: 'a', value: '1' }] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /no spec/i);
  assert.match(textOf(result), /ghost/);
  assert.match(textOf(result), /application not found/);
  assert.doesNotMatch(textOf(result), /Cannot read propert/);
  assert.equal(patches.length, 0);
});

// Catches: the concurrent-modification branch anchored with `^`, which cannot
// match because the HTTP client prefixes the message; the underlying error
// dropped from the message it is replaced by.
test('set_application_parameters maps a failed test op to a concurrency error', async () => {
  const server = paramServer();
  stubClient(
    server,
    {
      metadata: { name: 'my-app' },
      spec: { source: { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } } }
    },
    () => {
      throw new Error(
        'ArgoCD PATCH /api/v1/applications/my-app failed with status 500: testing value /spec/source/helm/parameters failed: test failed'
      );
    }
  );

  const result = await setParams(server, {
    applicationName: 'my-app',
    helm: { parameters: [{ name: 'a', value: '2' }] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /modified concurrently/i);
  assert.match(textOf(result), /retry/i);
  assert.match(textOf(result), /testing value \/spec\/source\/helm\/parameters failed/);
});

// Catches: a concurrency test loose enough to match any failure that mentions
// "test" before "fail" — the application name here does, and the HTTP client's
// prefix supplies the "failed". Telling this caller to re-read and retry would
// send them past a permission error that no retry fixes.
test('set_application_parameters does not blame concurrency for an unrelated patch failure', async () => {
  const server = paramServer();
  stubClient(
    server,
    {
      metadata: { name: 'test-app' },
      spec: { source: { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } } }
    },
    () => {
      throw new Error(
        'ArgoCD PATCH /api/v1/applications/test-app failed with status 403: permission denied: applications, update, default/test-app'
      );
    }
  );

  const result = await setParams(server, {
    applicationName: 'test-app',
    helm: { parameters: [{ name: 'a', value: '2' }] }
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /permission denied/);
  assert.doesNotMatch(textOf(result), /modified concurrently/i);
});

// ---------------------------------------------------------------------------
// applicationName validation
//
// This is the only tool that reads an application and then writes it back, and
// the name is interpolated raw into the URL path of both requests. Only the GET
// carries appNamespace as a query parameter (the PATCH takes it in the body), so
// a name smuggling one sends the two requests at different applications.
//
// Asserted against the registered schema, not the handler: the MCP SDK applies
// the schema before the handler runs, so the schema is what actually rejects
// these — a handler-level check would pass even with the schema reverted.

const paramsSchemaOf = (
  server: ReturnType<typeof createServer>
): { safeParse: (value: unknown) => { success: boolean } } =>
  (
    server as unknown as {
      _registeredTools: Record<
        string,
        { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }
      >;
    }
  )._registeredTools['set_application_parameters'].inputSchema;

const nameIsAccepted = (
  server: ReturnType<typeof createServer>,
  applicationName: unknown
): boolean => paramsSchemaOf(server).safeParse({ applicationName }).success;

// Catches: applicationName reverted to a bare z.string(), or a regex that is not
// anchored at both ends — each of these names then reaches the URL path.
test('set_application_parameters rejects an applicationName that is not a plain resource name', () => {
  const server = paramServer();

  // The GET resolves to .../applications/my-app?appNamespace=evil-ns and reads from
  // evil-ns, while the PATCH body carries no appNamespace and writes my-app in the
  // default namespace: the merge is computed from one application, applied to another.
  assert.equal(nameIsAccepted(server, 'my-app?appNamespace=evil-ns'), false);
  // Path traversal: both requests resolve to .../applications/other-app.
  assert.equal(nameIsAccepted(server, 'my-app/../other-app'), false);
  assert.equal(nameIsAccepted(server, '../other-app'), false);
  // An empty name resolves to the collection endpoint, not an application.
  assert.equal(nameIsAccepted(server, ''), false);
  // Kubernetes resource names are lowercase; an uppercase one cannot exist, so
  // accepting it would only ever produce a confusing 404 on a write path.
  assert.equal(nameIsAccepted(server, 'My-App'), false);
});

// Catches: a regex tightened past what Kubernetes allows — dots and dashes are
// both legal in a resource name, and rejecting them would break ordinary calls.
test('set_application_parameters accepts an ordinary application name', () => {
  const server = paramServer();

  assert.equal(nameIsAccepted(server, 'my-app'), true);
  assert.equal(nameIsAccepted(server, 'team-a.my-app-2.v1'), true);
  assert.equal(nameIsAccepted(server, 'a'), true);
});

// Catches: the three warnings dropped from the description. A model chooses how
// to call this tool from the description alone, and each of these is a way the
// call can succeed and still not do what was intended.
test('set_application_parameters describes the auto-sync, durability and dryRun caveats', async () => {
  const server = paramServer();
  const description = (
    server as unknown as { _registeredTools: Record<string, { description?: string }> }
  )._registeredTools['set_application_parameters'].description;

  assert.ok(description, 'the tool has a description');
  // An automated sync policy makes this write a deploy.
  assert.match(description, /automated sync/i);
  assert.match(description, /deploy/i);
  // durability reports whether the override survives reconciliation.
  assert.match(description, /durab/i);
  assert.match(description, /revert/i);
  // Both verdicts, not just the negative one: a description that defines only
  // durable: false invites the contrapositive, and a model reading durable: true
  // will relay "this override will survive". It is not a guarantee, and the one
  // topology the check cannot see has to be named here — this description is the
  // only one of the four artifacts documenting it that is in the model's context
  // at call time. The README is not.
  assert.match(description, /durable is true/i);
  assert.match(description, /owner reference/i);
  assert.match(description, /namespace other than its own/i);
  // dryRun is a local merge preview, not server-side validation.
  assert.match(description, /dryRun/);
  assert.match(description, /local preview/i);
});

// Catches: the two merge rules a caller cannot infer from the argument names
// being dropped from the description. Neither is discoverable from the schema:
// an appended value file silently outranks the existing ones, and a kustomize
// image key that swallows a port or a digest changes which entry is replaced.
test('set_application_parameters describes the valueFiles precedence and kustomize image key', async () => {
  const server = paramServer();
  const description = (
    server as unknown as { _registeredTools: Record<string, { description?: string }> }
  )._registeredTools['set_application_parameters'].description;

  assert.ok(description, 'the tool has a description');
  // An appended value file lands last, which is highest precedence in Helm.
  assert.match(description, /valueFiles/);
  assert.match(description, /appended/i);
  assert.match(description, /precedence/i);
  // The image key is the priority-ordered delimiter search, not a positional one,
  // and both surprising consequences of it are called out.
  assert.match(description, /priority order/i);
  assert.match(description, /sha256/);
  assert.match(description, /localhost/);
});

// ---------------------------------------------------------------------------
// Read-only gating
//
// isReadOnly is read from process.env.MCP_READ_ONLY in the constructor, so the
// variable has to be set before createServer and restored afterwards. The
// restore runs in a finally: a leaked value would un-register every write tool
// for the rest of the run, failing later tests for a reason that has nothing to
// do with them.

const registeredToolNames = (server: ReturnType<typeof createServer>): string[] =>
  Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
  );

const withReadOnlyEnv = <T>(value: string | undefined, body: () => T): T => {
  const previous = process.env.MCP_READ_ONLY;
  if (value === undefined) {
    delete process.env.MCP_READ_ONLY;
  } else {
    process.env.MCP_READ_ONLY = value;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_READ_ONLY;
    } else {
      process.env.MCP_READ_ONLY = previous;
    }
  }
};

// Catches: the registration moved out of the `if (!isReadOnly)` block, which
// would let a read-only server write to the application spec. The two sanity
// assertions catch the way this test could pass while proving nothing — a
// misspelled or ineffective env var leaves every write tool registered, so
// sync_application being absent is what shows read-only mode was in effect, and
// list_applications being present shows the server registered anything at all.
test('set_application_parameters is not registered in read-only mode', () => {
  const names = withReadOnlyEnv('true', () => registeredToolNames(paramServer()));

  assert.equal(names.includes('set_application_parameters'), false);
  assert.equal(names.includes('sync_application'), false);
  assert.equal(names.includes('list_applications'), true);
});

// Catches: the tool gated on the wrong condition (or never registered at all),
// which would make the read-only test above pass vacuously.
test('set_application_parameters is registered when not in read-only mode', () => {
  const names = withReadOnlyEnv(undefined, () => registeredToolNames(paramServer()));

  assert.equal(names.includes('set_application_parameters'), true);
  assert.equal(names.includes('sync_application'), true);
});

// Catches: the MCP_READ_ONLY parse rule loosened or tightened. Nothing pinned it, and it
// gates every write tool on the server — a rule that stopped folding case would leave
// MCP_READ_ONLY=TRUE writable while the operator believes it is not.
//
// The values sit at the edges of the rule as written (trim, lowercase, === 'true'). '1'
// is pinned as NOT read-only, which is today's behaviour and a surprise worth recording:
// it is a common way to spell a boolean env var, and a truthiness check would honour it.
// Recorded rather than changed — the gate predates this feature, and widening it would
// silently un-register write tools for someone already setting MCP_READ_ONLY=1.
test('MCP_READ_ONLY gates write tools on a trimmed, case-folded "true" and nothing else', () => {
  const gatesWrites = (value: string): boolean => {
    const names = withReadOnlyEnv(value, () => registeredToolNames(paramServer()));
    // The read tool is asserted alongside so the check cannot pass by the server having
    // failed to register anything at all.
    assert.equal(names.includes('list_applications'), true);
    return !names.includes('set_application_parameters');
  };

  assert.equal(gatesWrites('TRUE'), true);
  assert.equal(gatesWrites(' true '), true);
  assert.equal(gatesWrites('1'), false);
  assert.equal(gatesWrites(''), false);
});
