import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenExchanger, TokenExchangeError } from './tokenExchange.js';

const ENDPOINT = new URL('https://id.example.com/application/o/token/');

type Call = { url: string; init: RequestInit; form: URLSearchParams };

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const setup = (
  respond: (call: Call, n: number) => Response | Promise<Response>,
  extra: Partial<ConstructorParameters<typeof TokenExchanger>[0]> = {}
) => {
  const calls: Call[] = [];
  const clock = { t: 1_000_000 };
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const call: Call = {
      url: String(input),
      init,
      form: new URLSearchParams(String(init.body))
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as unknown as typeof fetch;
  const exchanger = new TokenExchanger({
    tokenEndpoint: async () => ENDPOINT,
    clientId: 'mcp-client',
    audience: 'argocd',
    scope: 'openid profile email',
    fetchImpl,
    now: () => clock.t,
    ...extra
  });
  return { calls, clock, exchanger };
};

const ok = (token: string, expiresIn = 300) =>
  json(200, { access_token: token, expires_in: expiresIn });

test('sends the exact RFC 8693 form and no resource parameter', async () => {
  const { calls, exchanger } = setup(() => ok('argocd-1'));
  assert.equal(await exchanger.getToken('subject-1'), 'argocd-1');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, ENDPOINT.href);
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(call.form), {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: 'mcp-client',
    subject_token: 'subject-1',
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: 'argocd',
    scope: 'openid profile email'
  });
  assert.equal(call.form.has('resource'), false);
});

test('a token is cached until expires_in minus the skew, then re-exchanged', async () => {
  const { calls, clock, exchanger } = setup((_c, n) => ok(`t${n}`, 100));
  assert.equal(await exchanger.getToken('s'), 't1');
  clock.t += 69_999;
  assert.equal(await exchanger.getToken('s'), 't1');
  assert.equal(calls.length, 1);
  clock.t += 1;
  assert.equal(await exchanger.getToken('s'), 't2');
  assert.equal(calls.length, 2);
});

test('refreshSkewSeconds is honoured', async () => {
  const { calls, clock, exchanger } = setup((_c, n) => ok(`t${n}`, 100), {
    refreshSkewSeconds: 10
  });
  await exchanger.getToken('s');
  clock.t += 89_999;
  await exchanger.getToken('s');
  assert.equal(calls.length, 1);
  clock.t += 1;
  await exchanger.getToken('s');
  assert.equal(calls.length, 2);
});

test('concurrent calls for one subject share a single exchange', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { calls, exchanger } = setup(async () => {
    await gate;
    return ok('shared');
  });
  const all = Promise.all([1, 2, 3, 4, 5].map(() => exchanger.getToken('s')));
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await all, ['shared', 'shared', 'shared', 'shared', 'shared']);
  assert.equal(calls.length, 1);
});

test('invalidate forces a new exchange', async () => {
  const { calls, exchanger } = setup((_c, n) => ok(`t${n}`));
  assert.equal(await exchanger.getToken('s'), 't1');
  exchanger.invalidate('s');
  assert.equal(await exchanger.getToken('s'), 't2');
  assert.equal(calls.length, 2);
});

test('invalidate with a stale rejected token keeps the fresh replacement', async () => {
  const { calls, exchanger } = setup((_c, n) => ok(`t${n}`));
  assert.equal(await exchanger.getToken('s'), 't1');
  exchanger.invalidate('s', 't1');
  assert.equal(await exchanger.getToken('s'), 't2');
  // A second call that also failed with t1 must not discard t2.
  exchanger.invalidate('s', 't1');
  assert.equal(await exchanger.getToken('s'), 't2');
  assert.equal(calls.length, 2);
});

test('invalidating one subject leaves others cached', async () => {
  const { calls, exchanger } = setup((_c, n) => ok(`t${n}`));
  await exchanger.getToken('a');
  await exchanger.getToken('b');
  exchanger.invalidate('a');
  assert.equal(await exchanger.getToken('b'), 't2');
  assert.equal(calls.length, 2);
});

test('different subject tokens are exchanged separately', async () => {
  const { calls, exchanger } = setup((c) => ok(`for-${c.form.get('subject_token')}`));
  assert.equal(await exchanger.getToken('a'), 'for-a');
  assert.equal(await exchanger.getToken('b'), 'for-b');
  assert.equal(await exchanger.getToken('a'), 'for-a');
  assert.equal(calls.length, 2);
});

const SECRET = 'eyJ.super-secret-subject.token';

const failures: [string, () => Response | Promise<Response>, RegExp][] = [
  [
    '400 invalid_grant',
    () => json(400, { error: 'invalid_grant', error_description: SECRET }),
    /invalid_grant/
  ],
  ['403', () => json(403, { error: 'access_denied' }), /403/],
  ['500 non-JSON', () => json(500, 'Internal Server Error <html>'), /HTTP 500/],
  [
    'network error',
    () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443');
    },
    /could not be reached/
  ]
];

for (const [name, respond, pattern] of failures) {
  test(`error mapping: ${name} is a TokenExchangeError without the subject token`, async () => {
    const { exchanger } = setup(respond);
    await assert.rejects(exchanger.getToken(SECRET), (error: unknown) => {
      assert.ok(error instanceof TokenExchangeError);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
  });
}

test('a 200 without access_token is rejected', async () => {
  const { exchanger } = setup(() => json(200, { expires_in: 300 }));
  await assert.rejects(exchanger.getToken('s'), /no access_token/);
});

test('a 200 with an empty access_token is rejected', async () => {
  const { exchanger } = setup(() => json(200, { access_token: '', expires_in: 300 }));
  await assert.rejects(exchanger.getToken('s'), TokenExchangeError);
});

test('a 200 with a non-JSON body is rejected', async () => {
  const { exchanger } = setup(() => json(200, 'not json'));
  await assert.rejects(exchanger.getToken('s'), TokenExchangeError);
});

for (const bad of [undefined, 0, -5, '300', null, Number.NaN]) {
  test(`expires_in ${JSON.stringify(bad)} is rejected`, async () => {
    const { exchanger } = setup(() => json(200, { access_token: 'x', expires_in: bad }));
    await assert.rejects(exchanger.getToken('s'), /expires_in/);
  });
}

test('a failed exchange is not cached: the next call retries', async () => {
  const { calls, exchanger } = setup((_c, n) =>
    n === 1 ? json(500, { error: 'server_error' }) : ok('recovered')
  );
  await assert.rejects(exchanger.getToken('s'), TokenExchangeError);
  assert.equal(await exchanger.getToken('s'), 'recovered');
  assert.equal(calls.length, 2);
  assert.equal(exchanger.size, 1);
});

test('maxEntries keeps the cache bounded and evicts the oldest', async () => {
  const { calls, exchanger } = setup((_c, n) => ok(`t${n}`, 3600), { maxEntries: 3 });
  for (let i = 0; i < 10; i++) await exchanger.getToken(`s${i}`);
  assert.ok(exchanger.size <= 3);
  assert.equal(exchanger.size, 3);
  const before = calls.length;
  await exchanger.getToken('s9');
  assert.equal(calls.length, before);
  await exchanger.getToken('s0');
  assert.equal(calls.length, before + 1);
});

test('expired entries are dropped before live ones when the cache is full', async () => {
  const { calls, clock, exchanger } = setup((_c, n) => ok(`t${n}`, n === 1 ? 10 : 3600), {
    maxEntries: 2
  });
  await exchanger.getToken('short');
  await exchanger.getToken('long');
  clock.t += 20_000;
  await exchanger.getToken('new');
  const before = calls.length;
  await exchanger.getToken('long');
  assert.equal(calls.length, before);
});
