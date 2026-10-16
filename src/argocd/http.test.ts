import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from './http.js';

// HttpClient.patch is the only verb that checks response.ok. The shared request()
// deliberately does not — it hands an error body back cast to the success type — so
// this check is the single thing that makes a failed write visible. If it regresses,
// every failed PATCH (a failed RFC 6902 `test` op, a 403, a 404) returns as a success
// whose body is cast to V1alpha1Application, and set_application_parameters reports
// applied: true for a write that never happened.
//
// fetch is stubbed rather than dialled: these tests make no network request. The
// restore runs in a finally, because a leaked stub would silently answer every later
// fetch in this file.

const BASE_URL = 'https://argocd.example.com';
const TOKEN = 'test-token';

type FetchCall = { url: string; init: RequestInit | undefined };

const withStubbedFetch = async <T>(
  respond: () => Response,
  body: (calls: FetchCall[]) => Promise<T>
): Promise<T> => {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof globalThis.fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const newClient = (): HttpClient => new HttpClient(BASE_URL, TOKEN);

// Catches: the `if (!response.ok)` check dropped, which turns every failed write into
// a resolved promise. It also pins both halves of the message: without the status a
// caller cannot tell a conflict from a permission error, and without the response text
// the handler's concurrency mapping has nothing to match on, so a failed `test` op
// would be reported as an unexplained failure instead of "retry after re-reading".
test('patch throws on a non-2xx response, naming the status and the response body', async () => {
  await withStubbedFetch(
    () =>
      new Response('testing value /spec/source/helm/parameters failed: test failed', {
        status: 409
      }),
    async () => {
      await assert.rejects(
        () => newClient().patch('/api/v1/applications/my-app', null, { patch: '[]' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /409/);
          assert.match(error.message, /testing value \/spec\/source\/helm\/parameters failed/);
          return true;
        }
      );
    }
  );
});

// Catches: JSON.parse called unconditionally on the response text. Argo CD may answer a
// PATCH with an empty body, and a SyntaxError thrown here reads to the caller exactly
// like a failed write — after the write has already landed.
test('patch resolves on a 2xx with an empty body instead of failing to parse it', async () => {
  await withStubbedFetch(
    () => new Response('', { status: 200 }),
    async () => {
      const response = await newClient().patch('/api/v1/applications/my-app', null, {
        patch: '[]'
      });

      assert.equal(response.status, 200);
      assert.equal(response.body, undefined);
    }
  );
});

// Catches: the method changed or dropped (a PATCH sent as a GET returns 200 and writes
// nothing, so the handler would report applied: true for no write); the body handed to
// fetch unserialized, which sends "[object Object]"; and the Authorization header
// dropped, which Argo CD answers with a 401.
test('patch sends the method, the serialized body and the Authorization header', async () => {
  const requestBody = { patch: '[{"op":"add","path":"/spec/source/helm","value":{}}]' };
  const responseBody = { metadata: { name: 'my-app' } };

  await withStubbedFetch(
    () => new Response(JSON.stringify(responseBody), { status: 200 }),
    async (calls) => {
      const response = await newClient().patch<typeof requestBody, typeof responseBody>(
        '/api/v1/applications/my-app',
        null,
        requestBody
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${BASE_URL}/api/v1/applications/my-app`);

      const init = calls[0].init;
      assert.ok(init, 'fetch is called with a request init');
      assert.equal(init.method, 'PATCH');
      assert.equal(init.body, JSON.stringify(requestBody));

      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(headers['Content-Type'], 'application/json');

      assert.deepEqual(response.body, responseBody);
    }
  );
});
