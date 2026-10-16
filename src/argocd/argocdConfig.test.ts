import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { getContextInfo, updateTokensInConfig } from './argocdConfig.js';

// Builds a minimal ArgoCD config YAML with one context + user
const makeConfig = (opts: {
  contextName: string;
  server: string;
  userName?: string;
  authToken?: string;
  refreshToken?: string;
}): string => {
  const userName = opts.userName ?? opts.server;
  return dump({
    contexts: [{ name: opts.contextName, server: opts.server, user: opts.userName }],
    users: [
      {
        name: userName,
        'auth-token': opts.authToken,
        'refresh-token': opts.refreshToken
      }
    ]
  });
};

let tmpDir: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'argocd-config-test-'));
  configPath = join(tmpDir, 'config');
  savedEnv = process.env.ARGOCD_CONFIG_HOME;
  process.env.ARGOCD_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.ARGOCD_CONFIG_HOME;
  } else {
    process.env.ARGOCD_CONFIG_HOME = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- getContextInfo ----------------------------------------------------------

test('getContextInfo returns baseUrl, authToken, refreshToken for a valid context', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'tok-abc',
      refreshToken: 'rt-xyz'
    })
  );

  const info = getContextInfo('my-cluster');

  assert.equal(info.server, 'argocd.example.com');
  assert.equal(info.baseUrl, 'https://argocd.example.com');
  assert.equal(info.authToken, 'tok-abc');
  assert.equal(info.refreshToken, 'rt-xyz');
});

test('getContextInfo returns undefined refreshToken when absent', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'tok-abc'
    })
  );

  const info = getContextInfo('my-cluster');
  assert.equal(info.refreshToken, undefined);
});

test('getContextInfo uses server as userName when ctx.user is absent', () => {
  // yaml dump omits undefined keys, so user field won't appear in contexts
  writeFileSync(
    configPath,
    dump({
      contexts: [{ name: 'ctx', server: 'argocd.example.com' }],
      users: [{ name: 'argocd.example.com', 'auth-token': 'tok-server-fallback' }]
    })
  );

  const info = getContextInfo('ctx');
  assert.equal(info.authToken, 'tok-server-fallback');
});

test('getContextInfo throws when context name not found', () => {
  writeFileSync(
    configPath,
    makeConfig({ contextName: 'other', server: 'argocd.example.com', authToken: 'tok' })
  );

  assert.throws(() => getContextInfo('missing'), /context "missing" not found/);
});

test('getContextInfo error message includes available context names', () => {
  writeFileSync(
    configPath,
    makeConfig({ contextName: 'prod', server: 'argocd.example.com', authToken: 'tok' })
  );

  assert.throws(() => getContextInfo('staging'), /prod/);
});

test('getContextInfo throws when auth-token is absent', () => {
  writeFileSync(
    configPath,
    dump({
      contexts: [{ name: 'ctx', server: 'argocd.example.com' }],
      users: [{ name: 'argocd.example.com' }]
    })
  );

  assert.throws(() => getContextInfo('ctx'), /No auth-token found/);
});

test('getContextInfo throws when config file is missing', () => {
  // No file written — configPath does not exist
  assert.throws(() => getContextInfo('ctx'), /ENOENT/);
});

// --- updateTokensInConfig ----------------------------------------------------

test('updateTokensInConfig writes new auth-token to config file', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'old-token'
    })
  );

  updateTokensInConfig('my-cluster', 'new-token');

  const info = getContextInfo('my-cluster');
  assert.equal(info.authToken, 'new-token');
});

test('updateTokensInConfig also updates refresh-token when provided', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'old-token',
      refreshToken: 'old-rt'
    })
  );

  updateTokensInConfig('my-cluster', 'new-token', 'new-rt');

  const info = getContextInfo('my-cluster');
  assert.equal(info.authToken, 'new-token');
  assert.equal(info.refreshToken, 'new-rt');
});

test('updateTokensInConfig does not clobber refresh-token when new one is absent', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'old-token',
      refreshToken: 'keep-me'
    })
  );

  updateTokensInConfig('my-cluster', 'new-token');

  const info = getContextInfo('my-cluster');
  assert.equal(info.refreshToken, 'keep-me');
});

test('updateTokensInConfig write is atomic: file is valid YAML after update', () => {
  writeFileSync(
    configPath,
    makeConfig({
      contextName: 'my-cluster',
      server: 'argocd.example.com',
      authToken: 'old-token'
    })
  );

  updateTokensInConfig('my-cluster', 'new-token');

  // File must be readable and parseable after write
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.length > 0);
  assert.doesNotThrow(() => getContextInfo('my-cluster'));
});

test('updateTokensInConfig throws when user entry is missing', () => {
  writeFileSync(
    configPath,
    dump({
      contexts: [{ name: 'ctx', server: 'argocd.example.com' }],
      users: []
    })
  );

  assert.throws(() => updateTokensInConfig('ctx', 'new-token'), /user entry not found/);
});

// --- ARGOCD_CONFIG_HOME env var ----------------------------------------------

test('ARGOCD_CONFIG_HOME redirects config path', () => {
  // Config written to tmpDir/config (set in beforeEach via ARGOCD_CONFIG_HOME)
  writeFileSync(
    configPath,
    makeConfig({ contextName: 'ctx', server: 'argocd.example.com', authToken: 'tok' })
  );

  // Must read from the overridden path, not ~/.config/argocd/config
  const info = getContextInfo('ctx');
  assert.equal(info.authToken, 'tok');
});
