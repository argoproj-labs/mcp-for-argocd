import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './server.js';
import { TokenRegistry } from './tokenRegistry.js';

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
