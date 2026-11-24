import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, HttpError } from './http.js';

// The one-shot retry on 401 that lets a short-lived exchanged token be replaced.

type Seen = { method?: string; auth?: string; body: string };

const GOOD = 'good-token';
const BAD = 'bad-token';

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
const seenPaths: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push({ method: req.method, auth, body: Buffer.concat(chunks).toString('utf8') });
      seenPaths.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/missing') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found', message: 'application not found' }));
      } else if (auth === `Bearer ${GOOD}`) {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

test('a 401 is retried once with the token onUnauthorized returns', async () => {
  let calls = 0;
  const client = new HttpClient(baseUrl, BAD, {
    onUnauthorized: async () => {
      calls++;
      return GOOD;
    }
  });
  const res = await client.get<{ ok: boolean }>('/api/v1/x');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(calls, 1);
  assert.deepEqual(
    seen.map((s) => s.auth),
    [`Bearer ${BAD}`, `Bearer ${GOOD}`]
  );
  assert.equal(client.apiToken, GOOD);
});

const rejects401 = (error: unknown) =>
  error instanceof HttpError && error.status === 401 && /ArgoCD answered 401/.test(error.message);

test('without onUnauthorized the 401 is thrown and nothing is retried', async () => {
  const client = new HttpClient(baseUrl, BAD);
  await assert.rejects(client.get('/api/v1/x'), rejects401);
  assert.equal(seen.length, 1);
});

test('onUnauthorized returning undefined means no retry', async () => {
  const client = new HttpClient(baseUrl, BAD, { onUnauthorized: async () => undefined });
  await assert.rejects(client.get('/api/v1/x'), rejects401);
  assert.equal(seen.length, 1);
});

test('onUnauthorized returning the same token means no retry', async () => {
  const client = new HttpClient(baseUrl, BAD, { onUnauthorized: async () => BAD });
  await assert.rejects(client.get('/api/v1/x'), rejects401);
  assert.equal(seen.length, 1);
});

test('a successful first request never calls onUnauthorized', async () => {
  let calls = 0;
  const client = new HttpClient(baseUrl, GOOD, {
    onUnauthorized: async () => {
      calls++;
      return 'other';
    }
  });
  const res = await client.get('/api/v1/x');
  assert.equal(res.status, 200);
  assert.equal(calls, 0);
  assert.equal(seen.length, 1);
});

test('a POST body is sent again on the retry', async () => {
  const client = new HttpClient(baseUrl, BAD, { onUnauthorized: async () => GOOD });
  const payload = { name: 'app', nested: { a: 1 } };
  const res = await client.post('/api/v1/x', null, payload);
  assert.equal(res.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[1].method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].body), payload);
  assert.deepEqual(JSON.parse(seen[1].body), payload);
});

test('only one retry is made when the second attempt is also a 401', async () => {
  let calls = 0;
  const client = new HttpClient(baseUrl, BAD, {
    onUnauthorized: async () => {
      calls++;
      return 'still-bad';
    }
  });
  await assert.rejects(client.get('/api/v1/x'), rejects401);
  assert.equal(calls, 1);
  assert.equal(seen.length, 2);
});

test('the retried token is kept for later requests', async () => {
  let calls = 0;
  const client = new HttpClient(baseUrl, BAD, {
    onUnauthorized: async () => {
      calls++;
      return GOOD;
    }
  });
  await client.get('/api/v1/x');
  seen = [];
  const res = await client.get('/api/v1/y');
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.equal(seen.length, 1);
});

test('the base URL path is kept: ArgoCD served under a prefix', () => {
  for (const base of ['https://host/argocd', 'https://host/argocd/']) {
    const client = new HttpClient(base, GOOD);
    assert.equal(
      client.absUrl('/api/v1/applications').href,
      'https://host/argocd/api/v1/applications'
    );
    assert.equal(
      client.absUrl('api/v1/applications').href,
      'https://host/argocd/api/v1/applications'
    );
  }
  assert.equal(
    new HttpClient('https://host', GOOD).absUrl('/api/v1/applications').href,
    'https://host/api/v1/applications'
  );
});

test('a prefixed base URL is used on the wire', async () => {
  const client = new HttpClient(`${baseUrl}/argocd`, GOOD);
  await client.get('/api/v1/x');
  assert.equal(seen.length, 1);
  assert.equal(seenPaths.at(-1), '/argocd/api/v1/x');
});

test('a non-2xx answer other than 401 is thrown with its message', async () => {
  const client = new HttpClient(baseUrl, GOOD);
  await assert.rejects(client.get('/missing'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.match(error.message, /ArgoCD answered 404.*application not found/);
    return true;
  });
});
