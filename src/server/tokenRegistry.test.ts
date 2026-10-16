import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenRegistry } from './tokenRegistry.js';

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

// --- Profiles ------------------------------------------------------------

test('entries without a name contribute no profiles (backward compatible)', () => {
  const registry = new TokenRegistry([
    { baseUrl: 'https://argo-a.example.com', token: 'token-a' },
    { baseUrl: 'https://argo-b.example.com', token: 'token-b' }
  ]);
  assert.deepEqual(registry.listProfiles(), []);
  assert.equal(registry.getSize(), 2); // still routable by base URL
  assert.equal(registry.getDefaultProfileName(), undefined);
});

test('named entries become selectable profiles exposing name + baseUrl only', () => {
  const registry = new TokenRegistry([
    { name: 'prod', baseUrl: 'https://argo-a.example.com', token: 'token-a' },
    { name: 'staging', baseUrl: 'https://argo-b.example.com', token: 'token-b' }
  ]);
  assert.deepEqual(registry.listProfiles(), [
    { name: 'prod', baseUrl: 'https://argo-a.example.com' },
    { name: 'staging', baseUrl: 'https://argo-b.example.com' }
  ]);
});

test('listProfiles never exposes tokens', () => {
  const registry = new TokenRegistry([
    { name: 'prod', baseUrl: 'https://argo-a.example.com', token: 'super-secret-token' }
  ]);
  assert.ok(!JSON.stringify(registry.listProfiles()).includes('super-secret-token'));
});

test('getProfile resolves names case-insensitively', () => {
  const registry = new TokenRegistry([
    { name: 'Prod', baseUrl: 'https://argo-a.example.com', token: 'token-a' }
  ]);
  assert.deepEqual(registry.getProfile('prod'), {
    name: 'Prod',
    baseUrl: 'https://argo-a.example.com'
  });
  assert.deepEqual(registry.getProfile('PROD'), {
    name: 'Prod',
    baseUrl: 'https://argo-a.example.com'
  });
  assert.equal(registry.getProfile('missing'), undefined);
});

test('a single default: true entry sets the default profile name', () => {
  const registry = new TokenRegistry([
    { name: 'prod', baseUrl: 'https://argo-a.example.com', token: 'token-a' },
    { name: 'staging', baseUrl: 'https://argo-b.example.com', token: 'token-b', default: true }
  ]);
  assert.equal(registry.getDefaultProfileName(), 'staging');
});

test('constructor throws (fail closed) on duplicate profile names without leaking the token', () => {
  assert.throws(
    () =>
      new TokenRegistry([
        { name: 'prod', baseUrl: 'https://argo-a.example.com', token: 'super-secret-token' },
        { name: 'PROD', baseUrl: 'https://argo-b.example.com', token: 'token-b' }
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /duplicate profile name/);
      assert.ok(!error.message.includes('super-secret-token'));
      return true;
    }
  );
});

test('constructor throws (fail closed) when more than one profile is default', () => {
  assert.throws(
    () =>
      new TokenRegistry([
        { name: 'prod', baseUrl: 'https://argo-a.example.com', token: 'token-a', default: true },
        { name: 'staging', baseUrl: 'https://argo-b.example.com', token: 'token-b', default: true }
      ]),
    /more than one default profile/
  );
});
