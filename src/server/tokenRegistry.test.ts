import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenRegistry, parseTokenRegistry, tokenRegistryFromEnv } from './tokenRegistry.js';
import { CommandTokenProvider, StaticTokenProvider } from '../argocd/tokenProvider.js';

// Helper: write `contents` to a throwaway file and return its path. The file is
// removed when `cleanup` is called, keeping each test self-contained.
const withTempFile = (contents: string): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'token-registry-test-'));
  const path = join(dir, 'registry.json');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// Resolve the token a registry would use for a base URL, or undefined when the
// base URL is not registered.
const tokenFor = (registry: TokenRegistry, baseUrl: string): Promise<string | undefined> =>
  registry.getProvider(baseUrl)?.getToken() ?? Promise.resolve(undefined);

// --- TokenRegistry construction & lookup ---------------------------------

test('getProvider returns a static provider for a registered token entry', async () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  const provider = registry.getProvider('https://argo-a.example.com');
  assert.ok(provider instanceof StaticTokenProvider);
  assert.equal(await provider.getToken(), 'token-a');
});

test('getProvider returns a command provider for a tokenCommand entry', async () => {
  const registry = new TokenRegistry([
    {
      baseUrl: 'https://argo-a.example.com',
      tokenCommand: [process.execPath, '-e', `process.stdout.write('cmd-token')`]
    }
  ]);
  const provider = registry.getProvider('https://argo-a.example.com');
  assert.ok(provider instanceof CommandTokenProvider);
  assert.equal(await provider.getToken(), 'cmd-token');
});

test('getProvider returns the same provider instance on every lookup', () => {
  // The provider owns the token cache, so handing out a fresh instance per
  // lookup would defeat caching and coalescing.
  const registry = new TokenRegistry([
    { baseUrl: 'https://argo-a.example.com', tokenCommand: ['helper'] }
  ]);
  assert.equal(
    registry.getProvider('https://argo-a.example.com'),
    registry.getProvider('https://argo-a.example.com')
  );
});

test('getProvider returns undefined for an unregistered base URL', () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  assert.equal(registry.getProvider('https://argo-b.example.com'), undefined);
});

test('getProvider returns undefined for an empty base URL', () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  assert.equal(registry.getProvider(''), undefined);
});

test('lookups are normalized: host case and trailing slashes are ignored', async () => {
  const registry = new TokenRegistry([
    { baseUrl: 'https://Argo-A.Example.com/', token: 'token-a' }
  ]);
  assert.equal(await tokenFor(registry, 'https://argo-a.example.com'), 'token-a');
  assert.equal(await tokenFor(registry, 'https://ARGO-A.EXAMPLE.COM///'), 'token-a');
});

test('an empty registry has size 0 and finds nothing', () => {
  const registry = new TokenRegistry();
  assert.equal(registry.getSize(), 0);
  assert.equal(registry.getProvider('https://argo-a.example.com'), undefined);
});

test('tokenCommand entries pass TTL and timeout through to the provider', async () => {
  // Observable via validation: the provider rejects a non-positive TTL/timeout,
  // so if the values reach it, a bad value surfaces as a registry error.
  assert.throws(
    () =>
      new TokenRegistry([
        { baseUrl: 'https://argo-a.example.com', tokenCommand: ['helper'], tokenTTLSeconds: 0 }
      ]),
    /tokenTTLSeconds/
  );
  assert.throws(
    () =>
      new TokenRegistry([
        {
          baseUrl: 'https://argo-a.example.com',
          tokenCommand: ['helper'],
          tokenCommandTimeoutSeconds: 0
        }
      ]),
    /tokenCommandTimeoutSeconds/
  );
});

// --- Fail-closed: constructor rejects malformed entries ------------------

test('constructor throws when an entry has neither token nor tokenCommand', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: '' }]),
    /exactly one of "token" or "tokenCommand"/
  );
  assert.throws(
    () => new TokenRegistry([{ baseUrl: 'https://argo-a.example.com' }]),
    /exactly one of "token" or "tokenCommand"/
  );
});

test('constructor throws when an entry has both token and tokenCommand', () => {
  assert.throws(
    () =>
      new TokenRegistry([
        { baseUrl: 'https://argo-a.example.com', token: 'token-a', tokenCommand: ['helper'] }
      ]),
    /exactly one of "token" or "tokenCommand"/
  );
});

test('constructor throws when tokenCommand is not a non-empty array of strings', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', tokenCommand: [] }]),
    /tokenCommand/
  );
  assert.throws(
    () =>
      new TokenRegistry([
        {
          baseUrl: 'https://argo-a.example.com',
          tokenCommand: 'gcloud auth print-identity-token' as unknown as string[]
        }
      ]),
    /tokenCommand/
  );
});

test('constructor throws when TTL/timeout are given for a static token entry', () => {
  // Fail closed on a misconfiguration: an operator who set a TTL on a static
  // token probably expected it to be refreshed, which it never will be.
  assert.throws(
    () =>
      new TokenRegistry([
        { baseUrl: 'https://argo-a.example.com', token: 'token-a', tokenTTLSeconds: 60 }
      ]),
    /only valid with "tokenCommand"/
  );
});

test('constructor throws when an entry is missing its base URL', () => {
  assert.throws(() => new TokenRegistry([{ baseUrl: '', token: 'token-a' }]), /missing baseUrl/);
});

test('constructor error does not leak the token value', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: '', token: 'super-secret-token' }]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('super-secret-token'));
      return true;
    }
  );
});

test('constructor errors name the offending base URL when it is known', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: 'https://argo-a.example.com' }]),
    /https:\/\/argo-a\.example\.com/
  );
});

// --- parseTokenRegistry --------------------------------------------------

test('parseTokenRegistry builds a registry from a valid JSON array', async () => {
  const registry = parseTokenRegistry(
    JSON.stringify([
      { baseUrl: 'https://argo-a.example.com', token: 'token-a' },
      { baseUrl: 'https://argo-b.example.com', tokenCommand: ['helper'] }
    ])
  );
  assert.equal(registry.getSize(), 2);
  assert.equal(await tokenFor(registry, 'https://argo-a.example.com'), 'token-a');
  assert.ok(registry.getProvider('https://argo-b.example.com') instanceof CommandTokenProvider);
});

test('parseTokenRegistry throws on invalid JSON', () => {
  assert.throws(() => parseTokenRegistry('not json {'), /not valid JSON/);
});

test('parseTokenRegistry throws when the JSON is not an array', () => {
  assert.throws(
    () => parseTokenRegistry(JSON.stringify({ baseUrl: 'x', token: 'y' })),
    /must contain a JSON array/
  );
});

test('parseTokenRegistry throws when an array element is not an object', () => {
  assert.throws(() => parseTokenRegistry(JSON.stringify(['not-an-entry'])), /must be an object/);
});

// --- tokenRegistryFromEnv ------------------------------------------------

test('tokenRegistryFromEnv returns an empty registry when the path is unset', () => {
  assert.equal(tokenRegistryFromEnv(undefined).getSize(), 0);
  assert.equal(tokenRegistryFromEnv('').getSize(), 0);
  assert.equal(tokenRegistryFromEnv('   ').getSize(), 0);
});

test('tokenRegistryFromEnv loads a registry from a valid file', async () => {
  const { path, cleanup } = withTempFile(
    JSON.stringify([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }])
  );
  try {
    const registry = tokenRegistryFromEnv(path);
    assert.equal(registry.getSize(), 1);
    assert.equal(await tokenFor(registry, 'https://argo-a.example.com'), 'token-a');
  } finally {
    cleanup();
  }
});

test('tokenRegistryFromEnv throws (fail closed) when the configured file is missing', () => {
  assert.throws(
    () => tokenRegistryFromEnv('/nonexistent/path/registry.json'),
    /Failed to read ArgoCD token registry file/
  );
});

test('tokenRegistryFromEnv throws (fail closed) when the configured file is malformed', () => {
  const { path, cleanup } = withTempFile('not json {');
  try {
    assert.throws(() => tokenRegistryFromEnv(path), /not valid JSON/);
  } finally {
    cleanup();
  }
});
