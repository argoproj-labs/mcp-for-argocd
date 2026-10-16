import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArgoCDClient } from './client.js';
import { type PatchOp } from '../shared/parameters.js';

// patchApplication is the one client method that shapes a request body rather than
// forwarding one: Argo CD's patch endpoint takes the RFC 6902 document as a *string*
// under `patch`, and everything else in the body too. These tests pin that shaping.
//
// ArgoCDClient builds its HttpClient in the constructor, so the tests swap the private
// field on the instance for a stub that records the call. No network is involved, and
// HttpClient.patch itself (whose only behaviour is the fetch) is deliberately not
// exercised here.

const CANNED_APP = { metadata: { name: 'my-app' } };

const OPS: PatchOp[] = [
  { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'image.tag', value: 'v1' }] },
  { op: 'add', path: '/spec/source/helm/parameters', value: [{ name: 'image.tag', value: 'v2' }] }
];

type RecordedCall = {
  url: string;
  params: unknown;
  body: Record<string, unknown> | undefined;
};

const stubPatch = (client: ArgoCDClient): RecordedCall[] => {
  const calls: RecordedCall[] = [];
  (client as unknown as { client: unknown }).client = {
    patch: async (url: string, params: unknown, body: Record<string, unknown> | undefined) => {
      calls.push({ url, params, body });
      return { status: 200, headers: new Headers(), body: CANNED_APP };
    }
  };
  return calls;
};

const newClient = (): { client: ArgoCDClient; calls: RecordedCall[] } => {
  const client = new ArgoCDClient('https://argocd.example.com', 'test-token');
  return { client, calls: stubPatch(client) };
};

test('patchApplication sends the patch document as a serialized string with patchType json', async () => {
  const { client, calls } = newClient();

  const result = await client.patchApplication('my-app', OPS);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, '/api/v1/applications/my-app');
  // No query params: the endpoint takes every parameter in the body.
  assert.ok(call.params === null || call.params === undefined, 'patch is called with no params');

  const body = call.body;
  assert.ok(body, 'a request body is sent');
  // A string, not the array itself — Argo CD rejects a non-string `patch`.
  assert.equal(typeof body.patch, 'string');
  assert.deepEqual(JSON.parse(body.patch as string), OPS);
  assert.equal(body.patchType, 'json');
  // The method returns the response body, not the whole HttpResponse.
  assert.deepEqual(result, CANNED_APP);
});

test('patchApplication omits appNamespace and project entirely when no namespace is given', async () => {
  const { client, calls } = newClient();

  await client.patchApplication('my-app', OPS);

  const body = calls[0].body;
  assert.ok(body);
  // Own keys, not values: a key holding undefined would still serialize into the request.
  assert.deepEqual(Object.keys(body).sort(), ['patch', 'patchType']);
});

test('patchApplication includes appNamespace when supplied and never sends project', async () => {
  const { client, calls } = newClient();

  await client.patchApplication('my-app', OPS, { appNamespace: 'team-a' });

  const body = calls[0].body;
  assert.ok(body);
  assert.equal(body.appNamespace, 'team-a');
  // project is an optional server-side filter; name plus namespace already identify the app.
  assert.deepEqual(Object.keys(body).sort(), ['appNamespace', 'patch', 'patchType']);
});
