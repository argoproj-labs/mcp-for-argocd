import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  errors as joseErrors
} from 'jose';
import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  assertNoStaticCredentials,
  createDiscovery,
  createTokenVerifier,
  discoveryUrl,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  registerProtectedResourceMetadata,
  resolveOAuthConfig,
  subjectOf,
  userOf,
  type AuthorizationServer,
  type OAuthConfig,
  type TokenTypeCheck
} from './oauth.js';

const ISSUER = 'https://id.example.com/application/o/argocd-mcp/';
const AUDIENCE = 'argocd-mcp';
const PUBLIC = 'https://mcp.example.com/mcp';

const base = {
  MCP_OAUTH_ISSUER: ISSUER,
  MCP_OAUTH_AUDIENCE: AUDIENCE,
  MCP_PUBLIC_URL: PUBLIC,
  ARGOCD_TOKEN_EXCHANGE_AUDIENCE: 'argocd'
};

// resolveOAuthConfig

test('resolveOAuthConfig is undefined when nothing is set', () => {
  assert.equal(resolveOAuthConfig({}), undefined);
  assert.equal(resolveOAuthConfig({ UNRELATED: 'x' }), undefined);
});

test('resolveOAuthConfig applies defaults and keeps the issuer as written', () => {
  const config = resolveOAuthConfig(base)!;
  assert.equal(config.issuer, ISSUER);
  assert.equal(config.audience, AUDIENCE);
  assert.equal(config.publicUrl.href, PUBLIC);
  assert.deepEqual(config.scopes, ['openid', 'profile', 'email', 'offline_access']);
  assert.deepEqual(config.exchange, {
    audience: 'argocd',
    scope: 'openid profile email',
    clientId: AUDIENCE
  });
  assert.equal(
    resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'https://i.example.com/x' })!.issuer,
    'https://i.example.com/x'
  );
});

test('resolveOAuthConfig honours explicit scopes and client id', () => {
  const config = resolveOAuthConfig({
    ...base,
    MCP_OAUTH_SCOPES: '  openid   groups ',
    ARGOCD_TOKEN_EXCHANGE_SCOPE: 'openid  groups',
    ARGOCD_TOKEN_EXCHANGE_CLIENT_ID: 'other-client'
  })!;
  assert.deepEqual(config.scopes, ['openid', 'groups']);
  assert.equal(config.exchange.scope, 'openid groups');
  assert.equal(config.exchange.clientId, 'other-client');
});

test('resolveOAuthConfig throws when the issuer is missing but others are set', () => {
  const rest: Record<string, string | undefined> = { ...base };
  delete rest.MCP_OAUTH_ISSUER;
  assert.throws(() => resolveOAuthConfig(rest), /MCP_OAUTH_ISSUER/);
  assert.throws(() => resolveOAuthConfig({ MCP_OAUTH_SCOPES: 'openid' }), /MCP_OAUTH_ISSUER/);
});

for (const missing of ['MCP_OAUTH_AUDIENCE', 'MCP_PUBLIC_URL', 'ARGOCD_TOKEN_EXCHANGE_AUDIENCE']) {
  test(`resolveOAuthConfig throws when ${missing} is missing`, () => {
    const env: Record<string, string | undefined> = { ...base };
    delete env[missing];
    assert.throws(() => resolveOAuthConfig(env), new RegExp(missing));
  });
}

for (const name of [
  ...Object.keys(base),
  'MCP_OAUTH_SCOPES',
  'ARGOCD_TOKEN_EXCHANGE_SCOPE',
  'ARGOCD_TOKEN_EXCHANGE_CLIENT_ID'
]) {
  test(`resolveOAuthConfig rejects an empty ${name}`, () => {
    assert.throws(() => resolveOAuthConfig({ ...base, [name]: '' }), /empty/);
    assert.throws(() => resolveOAuthConfig({ ...base, [name]: '   ' }), /empty/);
  });
}

test('resolveOAuthConfig rejects non-https issuer and public URL', () => {
  assert.throws(
    () => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'http://id.example.com/' }),
    /https/
  );
  assert.throws(
    () => resolveOAuthConfig({ ...base, MCP_PUBLIC_URL: 'http://mcp.example.com/mcp' }),
    /https/
  );
  assert.throws(() => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'not a url' }), /valid URL/);
  assert.throws(
    () => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'ftp://id.example.com/' }),
    /https/
  );
});

test('resolveOAuthConfig accepts http on loopback', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const config = resolveOAuthConfig({
      ...base,
      MCP_OAUTH_ISSUER: `http://${host}:9000/`,
      MCP_PUBLIC_URL: `http://${host}:3000/mcp`
    })!;
    assert.equal(config.publicUrl.href, `http://${host}:3000/mcp`);
    assert.equal(config.issuer, `http://${host}:9000/`);
  }
});

test('resolveOAuthConfig rejects a public URL path other than /mcp', () => {
  for (const path of ['/', '/other', '/mcp/sub']) {
    assert.throws(
      () => resolveOAuthConfig({ ...base, MCP_PUBLIC_URL: `https://mcp.example.com${path}` }),
      /\/mcp/
    );
  }
});

test('resolveOAuthConfig rejects credentials, query and fragment in URLs', () => {
  for (const url of [
    'https://u:p@mcp.example.com/mcp',
    'https://mcp.example.com/mcp?a=1',
    'https://mcp.example.com/mcp#f'
  ]) {
    assert.throws(
      () => resolveOAuthConfig({ ...base, MCP_PUBLIC_URL: url }),
      /credentials, a query or a fragment/
    );
  }
  assert.throws(
    () => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'https://u:p@id.example.com/' }),
    /credentials/
  );
  assert.throws(
    () => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: 'https://id.example.com/?x=1' }),
    /query/
  );
});

// assertNoStaticCredentials

test('assertNoStaticCredentials refuses each static credential', () => {
  for (const name of ['MCP_AUTH_TOKEN', 'ARGOCD_API_TOKEN', 'ARGOCD_TOKEN_REGISTRY_PATH']) {
    assert.throws(
      () =>
        assertNoStaticCredentials({ ARGOCD_BASE_URL: 'https://argocd.example.com', [name]: 'x' }),
      new RegExp(name)
    );
  }
});

test('assertNoStaticCredentials ignores empty static credentials', () => {
  assert.doesNotThrow(() =>
    assertNoStaticCredentials({
      ARGOCD_BASE_URL: 'https://argocd.example.com',
      MCP_AUTH_TOKEN: '  '
    })
  );
});

test('assertNoStaticCredentials requires an https (or loopback http) ARGOCD_BASE_URL', () => {
  assert.throws(
    () => assertNoStaticCredentials({ ARGOCD_BASE_URL: 'http://argocd.example.com' }),
    /ARGOCD_BASE_URL must be an https URL/
  );
  assert.doesNotThrow(() =>
    assertNoStaticCredentials({ ARGOCD_BASE_URL: 'http://127.0.0.1:8080/argocd' })
  );
});

test('assertNoStaticCredentials requires ARGOCD_BASE_URL', () => {
  assert.throws(() => assertNoStaticCredentials({}), /ARGOCD_BASE_URL/);
  assert.throws(() => assertNoStaticCredentials({ ARGOCD_BASE_URL: ' ' }), /ARGOCD_BASE_URL/);
  assert.doesNotThrow(() =>
    assertNoStaticCredentials({ ARGOCD_BASE_URL: 'https://argocd.example.com' })
  );
});

// discoveryUrl

test('discoveryUrl appends to the issuer path with or without a trailing slash', () => {
  assert.equal(
    discoveryUrl('https://id.example.com'),
    'https://id.example.com/.well-known/openid-configuration'
  );
  assert.equal(
    discoveryUrl('https://id.example.com/'),
    'https://id.example.com/.well-known/openid-configuration'
  );
  assert.equal(
    discoveryUrl('https://id.example.com/application/o/x/'),
    'https://id.example.com/application/o/x/.well-known/openid-configuration'
  );
  assert.equal(
    discoveryUrl('https://id.example.com/application/o/x'),
    'https://id.example.com/application/o/x/.well-known/openid-configuration'
  );
});

// createDiscovery

const goodDocument = {
  issuer: ISSUER,
  jwks_uri: 'https://id.example.com/application/o/argocd-mcp/jwks/',
  token_endpoint: 'https://id.example.com/application/o/token/'
};

const fetchOf = (respond: (url: string, n: number) => Response | Promise<Response>) => {
  const urls: string[] = [];
  const impl = (async (input: string | URL) => {
    urls.push(String(input));
    return respond(String(input), urls.length);
  }) as unknown as typeof fetch;
  return { impl, urls };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('createDiscovery fetches the right URL once and memoizes success', async () => {
  const { impl, urls } = fetchOf(() => jsonResponse(goodDocument));
  const discover = createDiscovery(ISSUER, impl);
  const [a, b] = await Promise.all([discover(), discover()]);
  const c = await discover();
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0],
    'https://id.example.com/application/o/argocd-mcp/.well-known/openid-configuration'
  );
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a.issuer, ISSUER);
  assert.equal(a.jwksUri.href, goodDocument.jwks_uri);
  assert.equal(a.tokenEndpoint.href, goodDocument.token_endpoint);
});

test('createDiscovery retries after a failure', async () => {
  const { impl, urls } = fetchOf((_u, n) => {
    if (n === 1) throw new Error('network down');
    return jsonResponse(goodDocument);
  });
  const discover = createDiscovery(ISSUER, impl);
  await assert.rejects(discover(), /network down/);
  assert.equal((await discover()).issuer, ISSUER);
  assert.equal(urls.length, 2);
});

test('createDiscovery rejects an issuer mismatch, trailing slash included', async () => {
  const noSlash = ISSUER.replace(/\/$/, '');
  const { impl } = fetchOf(() => jsonResponse({ ...goodDocument, issuer: noSlash }));
  await assert.rejects(createDiscovery(ISSUER, impl)(), /trailing slash/);
});

test('createDiscovery rejects a non-200 answer', async () => {
  const { impl } = fetchOf(() => jsonResponse({}, 404));
  await assert.rejects(createDiscovery(ISSUER, impl)(), /HTTP 404/);
});

for (const field of ['jwks_uri', 'token_endpoint']) {
  test(`createDiscovery rejects a document without ${field}`, async () => {
    const doc: Record<string, unknown> = { ...goodDocument };
    delete doc[field];
    const { impl } = fetchOf(() => jsonResponse(doc));
    await assert.rejects(createDiscovery(ISSUER, impl)(), new RegExp(`no ${field}`));
  });

  test(`createDiscovery rejects a non-https ${field}`, async () => {
    const { impl } = fetchOf(() =>
      jsonResponse({ ...goodDocument, [field]: 'http://id.example.com/x' })
    );
    await assert.rejects(createDiscovery(ISSUER, impl)(), /https/);
  });
}

test('URL errors never echo the value, which may hold a pasted secret', () => {
  const SECRET = 's3cr3t-token';
  const bad = [
    `https://user:${SECRET}@id.example.com/`,
    `https://id.example.com/?token=${SECRET}`,
    `http://id.example.com/${SECRET}`,
    `not a url ${SECRET}`
  ];
  const cases: [string, () => unknown][] = [
    ...bad.map((value): [string, () => unknown] => [
      'MCP_OAUTH_ISSUER',
      () => resolveOAuthConfig({ ...base, MCP_OAUTH_ISSUER: value })
    ]),
    ...[...bad, `https://mcp.example.com/${SECRET}`].map((value): [string, () => unknown] => [
      'MCP_PUBLIC_URL',
      () => resolveOAuthConfig({ ...base, MCP_PUBLIC_URL: value })
    ]),
    ...bad.map((value): [string, () => unknown] => [
      'ARGOCD_BASE_URL',
      () => assertNoStaticCredentials({ ARGOCD_BASE_URL: value })
    ])
  ];
  for (const [name, run] of cases) {
    assert.throws(
      run,
      (error: unknown) =>
        error instanceof Error && error.message.startsWith(name) && !error.message.includes(SECRET),
      name
    );
  }
});

test('MCP_OAUTH_TOKEN_TYPE_CHECK defaults to at+jwt; scope must be chosen', () => {
  assert.equal(resolveOAuthConfig(base)!.tokenTypeCheck, 'at+jwt');
  assert.equal(
    resolveOAuthConfig({ ...base, MCP_OAUTH_TOKEN_TYPE_CHECK: 'SCOPE' })!.tokenTypeCheck,
    'scope'
  );
  assert.equal(
    resolveOAuthConfig({ ...base, MCP_OAUTH_TOKEN_TYPE_CHECK: 'at+jwt' })!.tokenTypeCheck,
    'at+jwt'
  );
  for (const bad of ['none', 'true', 'jwt']) {
    assert.throws(
      () => resolveOAuthConfig({ ...base, MCP_OAUTH_TOKEN_TYPE_CHECK: bad }),
      /MCP_OAUTH_TOKEN_TYPE_CHECK must be one of at\+jwt, scope/
    );
  }
});

// createTokenVerifier

type Keys = { privateKey: CryptoKey; publicJwk: JWK };

const makeKeys = async (alg = 'RS256', kid = 'k1'): Promise<Keys> => {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { privateKey, publicJwk };
};

let signer: Keys;
let other: Keys;

before(async () => {
  signer = await makeKeys();
  other = await makeKeys('RS256', 'k1');
});

const server: AuthorizationServer = {
  issuer: ISSUER,
  jwksUri: new URL(goodDocument.jwks_uri),
  tokenEndpoint: new URL(goodDocument.token_endpoint)
};

const verifier = (
  discover: () => Promise<AuthorizationServer> = async () => server,
  // Most tests below are about the scope fallback; the at+jwt default has its own.
  tokenTypeCheck: TokenTypeCheck = 'scope'
) =>
  createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, tokenTypeCheck }, discover, () =>
    createLocalJWKSet({ keys: [signer.publicJwk] })
  );

const nowSec = () => Math.floor(Date.now() / 1000);

const sign = async (
  claims: JWTPayload = {},
  opts: { key?: CryptoKey; alg?: string; omit?: string[]; exp?: number | null; typ?: string } = {}
) => {
  const payload: JWTPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    // Access tokens carry the granted scope; ID tokens do not.
    scope: 'openid profile email',
    exp: opts.exp === null ? undefined : (opts.exp ?? nowSec() + 600),
    ...claims
  };
  for (const name of opts.omit ?? []) delete payload[name];
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: opts.alg ?? 'RS256',
      kid: 'k1',
      ...(opts.typ ? { typ: opts.typ } : {})
    })
    .sign(opts.key ?? signer.privateKey);
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('a valid RS256 token yields AuthInfo', async () => {
  const exp = nowSec() + 600;
  const token = await sign({
    azp: 'client-xyz',
    scope: 'openid profile  email',
    email: 'a@example.com',
    preferred_username: 'alice',
    exp
  });
  const info = await verifier().verifyAccessToken(token);
  assert.equal(info.token, token);
  assert.equal(info.clientId, 'client-xyz');
  assert.deepEqual(info.scopes, ['openid', 'profile', 'email']);
  assert.equal(info.expiresAt, exp);
  assert.deepEqual(info.extra, { sub: 'user-1', email: 'a@example.com', username: 'alice' });
});

test('without azp the audience is the client id', async () => {
  const info = await verifier().verifyAccessToken(await sign());
  assert.equal(info.clientId, AUDIENCE);
  assert.deepEqual(info.scopes, ['openid', 'profile', 'email']);
});

test('an empty scope is an access token with no scopes', async () => {
  const info = await verifier().verifyAccessToken(await sign({ scope: '' }));
  assert.deepEqual(info.scopes, []);
});

test('an audience array containing ours is accepted', async () => {
  const info = await verifier().verifyAccessToken(await sign({ aud: ['other', AUDIENCE] }));
  assert.equal(info.extra?.sub, 'user-1');
});

const rejectsInvalid = (token: Promise<string> | string) =>
  assert.rejects(
    async () => verifier().verifyAccessToken(await token),
    (error: unknown) => {
      assert.ok(
        error instanceof InvalidTokenError,
        `expected InvalidTokenError, got ${String(error)}`
      );
      assert.equal(error.message.includes('"'), false);
      return true;
    }
  );

test('an expired token is an InvalidTokenError whose message has no double quotes', async () => {
  await assert.rejects(
    async () => verifier().verifyAccessToken(await sign({}, { exp: nowSec() - 3600 })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTokenError);
      assert.match(error.message, /expired/);
      assert.equal(error.message.includes('"'), false);
      return true;
    }
  );
});

test('wrong issuer is rejected', () => rejectsInvalid(sign({ iss: 'https://evil.example.com/' })));
test('wrong audience is rejected', () => rejectsInvalid(sign({ aud: 'someone-else' })));
test('a missing sub is rejected', () => rejectsInvalid(sign({}, { omit: ['sub'] })));
test('a missing exp is rejected', () => rejectsInvalid(sign({}, { exp: null })));
test('a token without scope (an ID token) is rejected', () =>
  rejectsInvalid(sign({}, { omit: ['scope'] })));

test('a missing required claim is described as such, not as a wrong audience', async () => {
  await assert.rejects(
    async () => verifier().verifyAccessToken(await sign({}, { omit: ['sub'] })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTokenError);
      assert.match(error.message, /lacks a required claim/);
      return true;
    }
  );
});

test('a key set that fails to load is a ServerError (500), not a 401', async () => {
  // jose reports a JWKS endpoint answering non-200 or non-JSON as a bare JOSEError.
  const failingKeys = createTokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    async () => server,
    () =>
      (async () => {
        throw new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response');
      }) as unknown as ReturnType<typeof createLocalJWKSet>
  );
  await assert.rejects(async () => failingKeys.verifyAccessToken(await sign()), ServerError);
});
test('a token signed by another key is rejected', () =>
  rejectsInvalid(sign({}, { key: other.privateKey })));
test('garbage is rejected', () => rejectsInvalid('not-a-jwt'));

test('an HS256 token is rejected', async () => {
  const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
  const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: 'u', exp: nowSec() + 600 })
    .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .sign(secret);
  await rejectsInvalid(token);
});

test('alg none is rejected', async () => {
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'u',
    exp: nowSec() + 600
  })}.`;
  await rejectsInvalid(token);
});

test('a discovery failure is a ServerError, not an InvalidTokenError', async () => {
  await assert.rejects(
    async () =>
      verifier(async () => {
        throw new Error('down');
      }).verifyAccessToken(await sign()),
    (error: unknown) => {
      assert.ok(error instanceof ServerError);
      assert.equal(error instanceof InvalidTokenError, false);
      return true;
    }
  );
});

test('a key set that cannot be reached is a ServerError', async () => {
  const failing = createTokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    async () => server,
    () =>
      (async () => {
        throw new Error('socket hang up');
      }) as never
  );
  await assert.rejects(async () => failing.verifyAccessToken(await sign()), ServerError);
});

// metadata

const config = resolveOAuthConfig(base) as OAuthConfig;

test('protectedResourceMetadata is the exact document', () => {
  assert.deepEqual(protectedResourceMetadata(config), {
    resource: PUBLIC,
    authorization_servers: [ISSUER],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Argo CD MCP server'
  });
});

test('protectedResourceMetadataUrl puts the well-known prefix before /mcp', () => {
  assert.equal(
    protectedResourceMetadataUrl(config),
    'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
  );
});

test('the metadata is served unauthenticated at both well-known paths', async () => {
  const app = express();
  registerProtectedResourceMetadata(app, config);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  try {
    const port = (listener.address() as AddressInfo).port;
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource'
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await res.json(), protectedResourceMetadata(config));
    }
  } finally {
    listener.closeAllConnections();
    await new Promise((r) => listener.close(r));
  }
});

// subjectOf

test('subjectOf reads the validated sub only', () => {
  const auth = (extra: unknown) => ({ token: 't', clientId: 'c', scopes: [], extra }) as never;
  assert.equal(subjectOf(undefined), undefined);
  assert.equal(subjectOf(auth(undefined)), undefined);
  assert.equal(subjectOf(auth({})), undefined);
  assert.equal(subjectOf(auth({ sub: '' })), undefined);
  assert.equal(subjectOf(auth({ sub: 42 })), undefined);
  assert.equal(subjectOf(auth({ sub: 'user-1' })), 'user-1');
});

// userOf

test('userOf prefers the username, then the email, then the subject', () => {
  const auth = (extra: Record<string, unknown>) => ({
    token: 't',
    clientId: 'c',
    scopes: [],
    extra
  });
  assert.equal(userOf(auth({ sub: 's', email: 'e@x', username: 'u' })), 'u');
  assert.equal(userOf(auth({ sub: 's', email: 'e@x' })), 'e@x');
  assert.equal(userOf(auth({ sub: 's' })), 's');
  assert.equal(userOf(undefined), undefined);
});

test('a Keycloak ID token (payload typ "ID") is refused even with a scope', async () => {
  await assert.rejects(
    async () => verifier().verifyAccessToken(await sign({ typ: 'ID' })),
    (error: unknown) =>
      error instanceof InvalidTokenError && /not an access token/.test(error.message)
  );
});

test('at+jwt: an at+jwt token is accepted, scope or not', async () => {
  for (const typ of ['at+jwt', 'application/at+jwt']) {
    const info = await verifier(undefined, 'at+jwt').verifyAccessToken(await sign({}, { typ }));
    assert.equal(info.extra?.sub, 'user-1');
  }
  const noScope = await verifier(undefined, 'at+jwt').verifyAccessToken(
    await sign({}, { typ: 'at+jwt', omit: ['scope'] })
  );
  assert.deepEqual(noScope.scopes, []);
});

test('at+jwt: a token without typ at+jwt is refused, even with a scope', async () => {
  for (const typ of [undefined, 'JWT']) {
    await assert.rejects(
      async () => verifier(undefined, 'at+jwt').verifyAccessToken(await sign({}, { typ })),
      (error: unknown) =>
        error instanceof InvalidTokenError && /not an access token/.test(error.message)
    );
  }
});

test('a verifier given no token type check uses at+jwt', async () => {
  const strict = createTokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    async () => server,
    () => createLocalJWKSet({ keys: [signer.publicJwk] })
  );
  await assert.rejects(async () => strict.verifyAccessToken(await sign()), InvalidTokenError);
  const info = await strict.verifyAccessToken(await sign({}, { typ: 'at+jwt' }));
  assert.equal(info.extra?.sub, 'user-1');
});
