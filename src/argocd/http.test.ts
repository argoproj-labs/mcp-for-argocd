import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { HttpClient } from './http.js';
import { StaticTokenProvider, type TokenProvider } from './tokenProvider.js';

// These tests exercise the HttpClient's authentication behaviour against a
// fake `fetch`: which bearer token each request carries, and what happens when
// ArgoCD answers 401. No network is involved.

type Recorded = { url: string; authorization: string | undefined };

const BASE_URL = 'https://argocd.example.com';

// A provider whose token can be changed between calls and that records
// invalidations. Stands in for a command-backed provider without spawning
// processes: the HttpClient only depends on the TokenProvider interface.
class FakeProvider implements TokenProvider {
  public readonly description = 'fake provider';
  public invalidations = 0;
  public tokens: string[] = [];
  constructor(
    private token: string,
    private readonly refreshable: boolean
  ) {}
  getToken(): Promise<string> {
    this.tokens.push(this.token);
    return Promise.resolve(this.token);
  }
  invalidate(): boolean {
    this.invalidations += 1;
    if (this.refreshable) this.token = `${this.token}-refreshed`;
    return this.refreshable;
  }
}

let recorded: Recorded[];
let responses: Array<() => Response>;
const originalFetch = globalThis.fetch;

const jsonResponse =
  (status: number, body: unknown = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });

const streamResponse = (lines: string[]) => () =>
  new Response(lines.map((l) => `${l}\n`).join(''), { status: 200 });

beforeEach(() => {
  recorded = [];
  responses = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    recorded.push({ url: String(input), authorization: headers.get('authorization') ?? undefined });
    const next = responses.shift();
    assert.ok(next, 'unexpected extra fetch call');
    return next();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('requests carry the provider token as a bearer Authorization header', async () => {
  responses.push(jsonResponse(200, { ok: true }));
  const client = new HttpClient(BASE_URL, new StaticTokenProvider('static-token'));

  const { status, body } = await client.get<{ ok: boolean }>('/api/v1/applications');

  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(recorded[0].authorization, 'Bearer static-token');
});

test('the token is resolved per request, not once at construction', async () => {
  // A command-backed provider yields a new token after its TTL; a long-lived
  // client must pick that up without being rebuilt.
  const provider = new FakeProvider('t1', true);
  const client = new HttpClient(BASE_URL, provider);
  responses.push(jsonResponse(200), jsonResponse(200));

  await client.get('/api/v1/applications');
  provider.invalidate();
  await client.get('/api/v1/applications');

  assert.deepEqual(
    recorded.map((r) => r.authorization),
    ['Bearer t1', 'Bearer t1-refreshed']
  );
});

test('a 401 with a refreshable provider invalidates the token and retries once', async () => {
  const provider = new FakeProvider('stale', true);
  const client = new HttpClient(BASE_URL, provider);
  responses.push(jsonResponse(401, { error: 'invalid session' }), jsonResponse(200, { ok: true }));

  const { status } = await client.get('/api/v1/applications');

  assert.equal(status, 200);
  assert.equal(provider.invalidations, 1);
  assert.deepEqual(
    recorded.map((r) => r.authorization),
    ['Bearer stale', 'Bearer stale-refreshed']
  );
});

test('a 401 with a static provider is returned as-is without retrying', async () => {
  const client = new HttpClient(BASE_URL, new StaticTokenProvider('static-token'));
  responses.push(jsonResponse(401, { error: 'invalid session' }));

  const { status } = await client.get('/api/v1/applications');

  assert.equal(status, 401);
  assert.equal(recorded.length, 1);
});

test('a second 401 after refreshing is returned, not retried again', async () => {
  const provider = new FakeProvider('stale', true);
  const client = new HttpClient(BASE_URL, provider);
  responses.push(jsonResponse(401), jsonResponse(401, { error: 'still invalid' }));

  const { status, body } = await client.get<{ error: string }>('/api/v1/applications');

  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'still invalid' });
  assert.equal(recorded.length, 2);
  assert.equal(provider.invalidations, 1);
});

test('mutating requests also refresh and retry on 401', async () => {
  const provider = new FakeProvider('stale', true);
  const client = new HttpClient(BASE_URL, provider);
  responses.push(jsonResponse(401), jsonResponse(200, { synced: true }));

  const { status } = await client.post('/api/v1/applications/app/sync', undefined, { prune: true });

  assert.equal(status, 200);
  assert.equal(recorded.length, 2);
});

test('streaming requests refresh and retry on 401 before any chunk is delivered', async () => {
  const provider = new FakeProvider('stale', true);
  const client = new HttpClient(BASE_URL, provider);
  responses.push(
    jsonResponse(401),
    streamResponse([JSON.stringify({ result: { content: 'line-1' } })])
  );
  const chunks: unknown[] = [];

  await client.getStream('/api/v1/applications/app/logs', undefined, (chunk) => chunks.push(chunk));

  assert.deepEqual(chunks, [{ content: 'line-1' }]);
  assert.deepEqual(
    recorded.map((r) => r.authorization),
    ['Bearer stale', 'Bearer stale-refreshed']
  );
});

test('a failing token provider rejects the request before anything is sent', async () => {
  const provider: TokenProvider = {
    description: 'broken helper',
    getToken: () => Promise.reject(new Error('command "helper" exited with code 1')),
    invalidate: () => true
  };
  const client = new HttpClient(BASE_URL, provider);

  await assert.rejects(() => client.get('/api/v1/applications'), /exited with code 1/);
  assert.equal(recorded.length, 0);
});
