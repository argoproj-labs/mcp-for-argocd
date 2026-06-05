import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenRegistry, parseTokenRegistry, tokenRegistryFromEnv } from './tokenRegistry.js';

// Helper: write `contents` to a throwaway file and return its path. The file is
// removed when `cleanup` is called, keeping each test self-contained.
const withTempFile = (contents: string): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'token-registry-test-'));
  const path = join(dir, 'registry.json');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// --- TokenRegistry construction & lookup ---------------------------------

test('getToken returns the configured token for a registered base URL', () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  assert.equal(registry.getToken('https://argo-a.example.com'), 'token-a');
});

test('getToken returns undefined for an unregistered base URL', () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  assert.equal(registry.getToken('https://argo-b.example.com'), undefined);
});

test('getToken returns undefined for an empty base URL', () => {
  const registry = new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }]);
  assert.equal(registry.getToken(''), undefined);
});

test('lookups are normalized: host case and trailing slashes are ignored', () => {
  const registry = new TokenRegistry([
    { baseUrl: 'https://Argo-A.Example.com/', token: 'token-a' }
  ]);
  assert.equal(registry.getToken('https://argo-a.example.com'), 'token-a');
  assert.equal(registry.getToken('https://ARGO-A.EXAMPLE.COM///'), 'token-a');
});

test('an empty registry has size 0 and finds nothing', () => {
  const registry = new TokenRegistry();
  assert.equal(registry.getSize(), 0);
  assert.equal(registry.getToken('https://argo-a.example.com'), undefined);
});

// --- Fail-closed: constructor rejects malformed entries ------------------

test('constructor throws when an entry is missing its token', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: 'https://argo-a.example.com', token: '' }]),
    /missing baseUrl or token/
  );
});

test('constructor throws when an entry is missing its base URL', () => {
  assert.throws(
    () => new TokenRegistry([{ baseUrl: '', token: 'token-a' }]),
    /missing baseUrl or token/
  );
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

// --- parseTokenRegistry --------------------------------------------------

test('parseTokenRegistry builds a registry from a valid JSON array', () => {
  const registry = parseTokenRegistry(
    JSON.stringify([
      { baseUrl: 'https://argo-a.example.com', token: 'token-a' },
      { baseUrl: 'https://argo-b.example.com', token: 'token-b' }
    ])
  );
  assert.equal(registry.getSize(), 2);
  assert.equal(registry.getToken('https://argo-b.example.com'), 'token-b');
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

// --- tokenRegistryFromEnv ------------------------------------------------

test('tokenRegistryFromEnv returns an empty registry when the path is unset', () => {
  assert.equal(tokenRegistryFromEnv(undefined).getSize(), 0);
  assert.equal(tokenRegistryFromEnv('').getSize(), 0);
  assert.equal(tokenRegistryFromEnv('   ').getSize(), 0);
});

test('tokenRegistryFromEnv loads a registry from a valid file', () => {
  const { path, cleanup } = withTempFile(
    JSON.stringify([{ baseUrl: 'https://argo-a.example.com', token: 'token-a' }])
  );
  try {
    const registry = tokenRegistryFromEnv(path);
    assert.equal(registry.getSize(), 1);
    assert.equal(registry.getToken('https://argo-a.example.com'), 'token-a');
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
