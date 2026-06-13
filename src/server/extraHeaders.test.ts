import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from './server.js';
import { TokenRegistry } from './tokenRegistry.js';

test('extra headers are attached to Argo CD HTTP requests', () => {
  const server = createServer({
    argocdBaseUrl: 'https://argocd.example.com',
    argocdApiToken: 'token',
    tokenRegistry: new TokenRegistry(),
    extraHeaders: { Cookie: 'x-og-token=ccccccxxxxx' }
  });

  const argoClient = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => {
        client: { headers: Record<string, string> };
      };
    }
  ).resolveClient({});

  assert.equal(argoClient.client.headers.Cookie, 'x-og-token=ccccccxxxxx');
  assert.equal(argoClient.client.headers.Authorization, 'Bearer token');
});

test('Authorization cannot be overridden by extra headers', () => {
  const server = createServer({
    argocdBaseUrl: 'https://argocd.example.com',
    argocdApiToken: 'real-token',
    tokenRegistry: new TokenRegistry(),
    extraHeaders: { Authorization: 'Bearer evil' }
  });

  const argoClient = (
    server as unknown as {
      resolveClient: (a: { argocdBaseUrl?: string }) => {
        client: { headers: Record<string, string> };
      };
    }
  ).resolveClient({});

  assert.equal(argoClient.client.headers.Authorization, 'Bearer real-token');
});
