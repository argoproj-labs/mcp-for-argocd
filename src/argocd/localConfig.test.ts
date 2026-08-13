import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  argoCdRegistrySource,
  parseArgoCdLocalConfig,
  tokenRegistryFromArgoCdConfig
} from './localConfig.js';

// A representative Argo CD CLI config (the shape written by `argocd login`),
// with two contexts: a default HTTPS one and a plain-text one.
const SAMPLE_CONFIG = `
contexts:
- name: prod
  server: argo-prod.example.com
  user: prod
- name: local
  server: argo-local.example.com
  user: local
current-context: prod
servers:
- server: argo-prod.example.com
  grpc-web: true
- server: argo-local.example.com
  plain-text: true
users:
- name: prod
  auth-token: token-prod
  refresh-token: refresh-prod
- name: local
  auth-token: token-local
`;

const withConfigFile = (contents: string): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'argocd-config-test-'));
  const path = join(dir, 'config');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// --- parseArgoCdLocalConfig ----------------------------------------------

test('parseArgoCdLocalConfig maps contexts to profile entries with the right scheme', () => {
  const { entries, currentContext } = parseArgoCdLocalConfig(SAMPLE_CONFIG);
  assert.equal(currentContext, 'prod');
  assert.deepEqual(entries, [
    { name: 'prod', baseUrl: 'https://argo-prod.example.com', token: 'token-prod', default: true },
    {
      name: 'local',
      baseUrl: 'http://argo-local.example.com',
      token: 'token-local',
      default: false
    }
  ]);
});

test('parseArgoCdLocalConfig skips contexts without an auth-token', () => {
  const config = `
contexts:
- name: prod
  server: argo-prod.example.com
  user: prod
- name: loggedout
  server: argo-out.example.com
  user: loggedout
current-context: prod
users:
- name: prod
  auth-token: token-prod
- name: loggedout
  refresh-token: only-refresh
`;
  const { entries } = parseArgoCdLocalConfig(config);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'prod');
});

test('parseArgoCdLocalConfig defaults to HTTPS when no matching server entry exists', () => {
  const config = `
contexts:
- name: prod
  server: argo-prod.example.com
  user: prod
users:
- name: prod
  auth-token: token-prod
`;
  const { entries } = parseArgoCdLocalConfig(config);
  assert.equal(entries[0].baseUrl, 'https://argo-prod.example.com');
});

test('parseArgoCdLocalConfig falls back to the context name when user is omitted', () => {
  const config = `
contexts:
- name: prod
  server: argo-prod.example.com
users:
- name: prod
  auth-token: token-prod
`;
  const { entries } = parseArgoCdLocalConfig(config);
  assert.equal(entries[0].token, 'token-prod');
});

test('parseArgoCdLocalConfig throws on malformed YAML', () => {
  assert.throws(() => parseArgoCdLocalConfig('this: : : not yaml'), /not valid YAML/);
});

test('parseArgoCdLocalConfig throws when the document is not a mapping', () => {
  assert.throws(() => parseArgoCdLocalConfig('- just\n- a\n- list'), /must contain a YAML mapping/);
});

// --- tokenRegistryFromArgoCdConfig ---------------------------------------

test('tokenRegistryFromArgoCdConfig returns an empty registry when no path is given', () => {
  assert.equal(tokenRegistryFromArgoCdConfig(undefined).listProfiles().length, 0);
  assert.equal(tokenRegistryFromArgoCdConfig('').getSize(), 0);
  assert.equal(tokenRegistryFromArgoCdConfig('   ').getSize(), 0);
});

test('tokenRegistryFromArgoCdConfig loads profiles + tokens from a config file', () => {
  const { path, cleanup } = withConfigFile(SAMPLE_CONFIG);
  try {
    const registry = tokenRegistryFromArgoCdConfig(path);
    assert.deepEqual(registry.listProfiles(), [
      { name: 'prod', baseUrl: 'https://argo-prod.example.com' },
      { name: 'local', baseUrl: 'http://argo-local.example.com' }
    ]);
    assert.equal(registry.getDefaultProfileName(), 'prod');
    // Tokens are routable but never surface in the profile list.
    assert.equal(registry.getToken('https://argo-prod.example.com'), 'token-prod');
    assert.ok(!JSON.stringify(registry.listProfiles()).includes('token-prod'));
  } finally {
    cleanup();
  }
});

test('tokenRegistryFromArgoCdConfig throws (fail closed) when the configured file is missing', () => {
  assert.throws(
    () => tokenRegistryFromArgoCdConfig('/nonexistent/path/config'),
    /Failed to read Argo CD config file/
  );
});

test('tokenRegistryFromArgoCdConfig throws (fail closed) when the file is malformed', () => {
  const { path, cleanup } = withConfigFile('this: : : not yaml');
  try {
    assert.throws(() => tokenRegistryFromArgoCdConfig(path), /not valid YAML/);
  } finally {
    cleanup();
  }
});

// --- argoCdRegistrySource (opportunistic reload) -------------------------

const ONE_CONTEXT = `
contexts:
- name: prod
  server: argo-prod.example.com
  user: prod
current-context: prod
users:
- name: prod
  auth-token: token-prod
`;

test('argoCdRegistrySource with no path is a fixed empty registry', () => {
  const source = argoCdRegistrySource(undefined);
  assert.equal(source.get().listProfiles().length, 0);
  assert.equal(source.reload().listProfiles().length, 0);
});

test('argoCdRegistrySource eager-loads and fails closed on a bad path', () => {
  assert.throws(
    () => argoCdRegistrySource('/nonexistent/path/config'),
    /Failed to read Argo CD config file/
  );
});

test('argoCdRegistrySource.reload() picks up a profile added after startup', () => {
  const { path, cleanup } = withConfigFile(ONE_CONTEXT);
  try {
    const source = argoCdRegistrySource(path);
    assert.deepEqual(
      source
        .get()
        .listProfiles()
        .map((p) => p.name),
      ['prod']
    );

    // A new `argocd login` adds a second context while the server runs.
    writeFileSync(
      path,
      `
contexts:
- name: prod
  server: argo-prod.example.com
  user: prod
- name: staging
  server: argo-staging.example.com
  user: staging
current-context: prod
users:
- name: prod
  auth-token: token-prod
- name: staging
  auth-token: token-staging
`,
      'utf8'
    );

    // get() still reflects the previously loaded state until a reload.
    assert.equal(source.get().listProfiles().length, 1);
    // reload() re-reads and now sees both profiles.
    assert.deepEqual(
      source
        .reload()
        .listProfiles()
        .map((p) => p.name),
      ['prod', 'staging']
    );
    // ...and get() reflects the refreshed registry afterwards.
    assert.equal(source.get().listProfiles().length, 2);
  } finally {
    cleanup();
  }
});

test('argoCdRegistrySource.reload() keeps the previous registry when the file becomes malformed', () => {
  const { path, cleanup } = withConfigFile(ONE_CONTEXT);
  try {
    const source = argoCdRegistrySource(path);
    assert.equal(source.get().listProfiles().length, 1);

    writeFileSync(path, 'this: : : not yaml', 'utf8');
    // A failed reload must not wipe or crash — the last good registry is kept.
    assert.deepEqual(
      source
        .reload()
        .listProfiles()
        .map((p) => p.name),
      ['prod']
    );
    assert.equal(source.get().listProfiles().length, 1);
  } finally {
    cleanup();
  }
});
