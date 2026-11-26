import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';
import { connectHttpTransport } from './transport.js';
import { resolveOAuthConfig, type OAuthConfig } from './oauth.js';
import { resolveListenerSecurity } from './security.js';

// End to end: the real HTTP transport in OAuth mode, against a fake authorization
// server (discovery, JWKS, RFC 8693 token endpoint) and a fake ArgoCD, all on
// loopback.

const AUDIENCE = 'argocd-mcp';
const EXCHANGE_AUDIENCE = 'argocd';

type Recorded = { headers: http.IncomingHttpHeaders; body: string; url: string };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

const freePort = async (): Promise<number> => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const listenOn = async (
  handler: Handler,
  port?: number
): Promise<{ server: http.Server; port: number; requests: Recorded[] }> => {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body, url: req.url ?? '' });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
};

const closeServer = (server: http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

type Env = {
  mcpPort: number;
  mcpUrl: string;
  issuer: string;
  oauth: OAuthConfig;
  argocdRequests: Recorded[];
  tokenRequests: Recorded[];
  otherRequests: Recorded[];
  otherUrl: string;
  state: {
    rejectArgocdTokens: Set<string>;
    exchangeStatus: number;
    exchangeCount: number;
  };
  sign: (claims?: Partial<SignOptions>) => Promise<string>;
  signWithOtherKey: () => Promise<string>;
};

type SignOptions = {
  sub: string;
  aud: string;
  iss: string;
  expiresIn: number | string;
  jti: string;
};

const withEnv = async (
  t: { after: (fn: () => void | Promise<void>) => void },
  options: { stateless?: boolean } = {}
): Promise<Env> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  const mcpPort = await freePort();
  const authPort = await freePort();
  const issuer = `http://127.0.0.1:${authPort}/application/o/argocd-mcp/`;

  const state = {
    rejectArgocdTokens: new Set<string>(),
    exchangeStatus: 200,
    exchangeCount: 0
  };

  const auth = await listenOn((req, res) => {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/application/o/argocd-mcp/.well-known/openid-configuration') {
      json(200, {
        issuer,
        jwks_uri: `http://127.0.0.1:${authPort}/application/o/argocd-mcp/jwks/`,
        token_endpoint: `http://127.0.0.1:${authPort}/application/o/token/`
      });
    } else if (req.url === '/application/o/argocd-mcp/jwks/') {
      json(200, { keys: [jwk] });
    } else if (req.url === '/application/o/token/' && req.method === 'POST') {
      if (state.exchangeStatus !== 200) {
        json(state.exchangeStatus, { error: 'access_denied' });
        return;
      }
      state.exchangeCount += 1;
      json(200, {
        access_token: `argocd-token-${state.exchangeCount}`,
        expires_in: 300,
        issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        token_type: 'Bearer'
      });
    } else {
      json(404, {});
    }
  }, authPort);
  t.after(() => closeServer(auth.server));

  const argocd = await listenOn((req, res) => {
    const authorization = req.headers.authorization ?? '';
    const token = authorization.replace(/^Bearer /, '');
    res.writeHead(state.rejectArgocdTokens.has(token) ? 401 : 200, {
      'content-type': 'application/json'
    });
    res.end(
      JSON.stringify(state.rejectArgocdTokens.has(token) ? { error: 'denied' } : { items: [] })
    );
  });
  t.after(() => closeServer(argocd.server));

  const other_ = await listenOn((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [] }));
  });
  t.after(() => closeServer(other_.server));

  const previousBase = process.env.ARGOCD_BASE_URL;
  process.env.ARGOCD_BASE_URL = `http://127.0.0.1:${argocd.port}`;
  t.after(() => {
    if (previousBase === undefined) delete process.env.ARGOCD_BASE_URL;
    else process.env.ARGOCD_BASE_URL = previousBase;
  });

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  const oauth = resolveOAuthConfig({
    MCP_OAUTH_ISSUER: issuer,
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_PUBLIC_URL: mcpUrl,
    ARGOCD_TOKEN_EXCHANGE_AUDIENCE: EXCHANGE_AUDIENCE
  })!;

  const server = connectHttpTransport({
    port: mcpPort,
    bindAddress: '127.0.0.1',
    oauth,
    stateless: options.stateless
  });
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => closeServer(server));

  const signWith = (key: CryptoKey, kid: string, claims: Partial<SignOptions> = {}) =>
    new SignJWT({
      azp: AUDIENCE,
      scope: 'openid profile email',
      jti: claims.jti ?? `${Math.random()}`
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? AUDIENCE)
      .setSubject(claims.sub ?? 'alice')
      .setIssuedAt()
      .setExpirationTime(claims.expiresIn ?? '5m')
      .sign(key);

  return {
    mcpPort,
    mcpUrl,
    issuer,
    oauth,
    argocdRequests: argocd.requests,
    tokenRequests: auth.requests,
    otherRequests: other_.requests,
    otherUrl: `http://127.0.0.1:${other_.port}`,
    state,
    sign: (claims) => signWith(privateKey, 'k1', claims),
    signWithOtherKey: () => signWith(other.privateKey, 'k1')
  };
};

// Token endpoint requests, in order.
const exchangesOf = (_env: Env, all: Recorded[]) =>
  all.filter((r) => r.url === '/application/o/token/');

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

const send = (
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: options.headers ?? {}
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });

// A JSON-RPC response, plain or SSE framed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseRpc = (body: string): { result?: any; error?: any } => {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  return JSON.parse(data);
};

const mcpHeaders = (port: number, token?: string, sessionId?: string, extra = {}) => ({
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  host: `127.0.0.1:${port}`,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  ...extra
});

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'oauth-test', version: '0.0.0' }
  }
};

const openSession = async (env: Env, token: string, extra = {}): Promise<string> => {
  const init = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token, undefined, extra),
    body: initializeBody
  });
  assert.equal(init.status, 200, init.body);
  const sessionId = init.headers['mcp-session-id'] as string;
  assert.ok(sessionId);
  const initialized = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token, sessionId, extra),
    body: { jsonrpc: '2.0', method: 'notifications/initialized' }
  });
  assert.equal(initialized.status, 202);
  return sessionId;
};

let nextId = 10;
const callTool = async (
  env: Env,
  token: string,
  sessionId: string,
  args: Record<string, unknown> = {},
  extra = {}
) => {
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token, sessionId, extra),
    body: {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name: 'list_applications', arguments: args }
    }
  });
  return { reply, rpc: reply.status === 200 ? parseRpc(reply.body) : undefined };
};

const authHeaderSeen = (env: Env) => env.argocdRequests.map((r) => r.headers.authorization);

// The token endpoint requests are recorded by the fake server; reach them through
// a getter bound at setup so the tests read like the assertions they make.
const setup = async (t: Parameters<typeof withEnv>[0], options = {}) => {
  const env = await withEnv(t, options);
  return env;
};

test('serves protected resource metadata without credentials', async (t) => {
  const env = await setup(t);
  const expected = {
    resource: env.mcpUrl,
    authorization_servers: [env.issuer],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Argo CD MCP server'
  };
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource'
  ]) {
    const reply = await send(env.mcpPort, {
      method: 'GET',
      path,
      headers: { host: `127.0.0.1:${env.mcpPort}` }
    });
    assert.equal(reply.status, 200, path);
    assert.deepEqual(JSON.parse(reply.body), expected, path);
  }
});

test('rejects a request without a token and points to the metadata', async (t) => {
  const env = await setup(t);
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort),
    body: initializeBody
  });
  assert.equal(reply.status, 401);
  const challenge = String(reply.headers['www-authenticate']);
  assert.match(
    challenge,
    new RegExp(
      `resource_metadata="http://127\\.0\\.0\\.1:${env.mcpPort}/\\.well-known/oauth-protected-resource/mcp"`
    )
  );
  assert.equal(env.argocdRequests.length, 0);
});

test('answers 401 invalid_token for an expired token, not 500', async (t) => {
  const env = await setup(t);
  const expired = await env.sign({ expiresIn: Math.floor(Date.now() / 1000) - 120 });
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, expired),
    body: initializeBody
  });
  assert.equal(reply.status, 401, reply.body);
  assert.match(String(reply.headers['www-authenticate']), /error="invalid_token"/);
  assert.ok(!reply.body.includes(expired));
});

test('rejects a token issued for another audience', async (t) => {
  const env = await setup(t);
  const token = await env.sign({ aud: 'something-else' });
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token),
    body: initializeBody
  });
  assert.equal(reply.status, 401);
  assert.match(String(reply.headers['www-authenticate']), /error="invalid_token"/);
});

test('rejects a token from another issuer', async (t) => {
  const env = await setup(t);
  const token = await env.sign({ iss: 'http://127.0.0.1:1/evil/' });
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token),
    body: initializeBody
  });
  assert.equal(reply.status, 401);
});

test('rejects a token signed by an unknown key', async (t) => {
  const env = await setup(t);
  const token = await env.signWithOtherKey();
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token),
    body: initializeBody
  });
  assert.equal(reply.status, 401);
  assert.match(String(reply.headers['www-authenticate']), /error="invalid_token"/);
});

test('rejects a malformed bearer token', async (t) => {
  const env = await setup(t);
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, 'not-a-jwt'),
    body: initializeBody
  });
  assert.equal(reply.status, 401);
});

test('calls ArgoCD with the exchanged token and caches it across calls', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const sessionId = await openSession(env, token);

  const first = await callTool(env, token, sessionId);
  assert.equal(first.rpc?.result?.isError, false, JSON.stringify(first.rpc));
  const second = await callTool(env, token, sessionId);
  assert.equal(second.rpc?.result?.isError, false, JSON.stringify(second.rpc));

  assert.equal(env.state.exchangeCount, 1);
  assert.equal(env.argocdRequests.length, 2);
  for (const seen of authHeaderSeen(env)) {
    assert.equal(seen, 'Bearer argocd-token-1');
    assert.ok(!seen?.includes(token));
  }
  for (const request of env.argocdRequests)
    assert.ok(request.url.startsWith('/api/v1/applications'));
});

test('sends an RFC 8693 request to the token endpoint, without resource', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const sessionId = await openSession(env, token);
  await callTool(env, token, sessionId);

  const exchanges = exchangesOf(env, env.tokenRequests);
  assert.equal(exchanges.length, 1);
  const form = new URLSearchParams(exchanges[0].body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
  assert.equal(form.get('client_id'), AUDIENCE);
  assert.equal(form.get('subject_token'), token);
  assert.equal(form.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(form.get('requested_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
  assert.equal(form.get('audience'), EXCHANGE_AUDIENCE);
  assert.equal(form.get('scope'), 'openid profile email');
  assert.equal(form.has('resource'), false);
  assert.match(String(exchanges[0].headers['content-type']), /application\/x-www-form-urlencoded/);
});

test('exchanges the new inbound token when the client refreshes', async (t) => {
  const env = await setup(t);
  const first = await env.sign({ jti: 'one' });
  const sessionId = await openSession(env, first);
  await callTool(env, first, sessionId);

  const refreshed = await env.sign({ jti: 'two' });
  assert.notEqual(refreshed, first);
  const result = await callTool(env, refreshed, sessionId);
  assert.equal(result.rpc?.result?.isError, false, JSON.stringify(result.rpc));

  assert.deepEqual(authHeaderSeen(env), ['Bearer argocd-token-1', 'Bearer argocd-token-2']);
  const forms = exchangesOf(env, env.tokenRequests).map((r) =>
    new URLSearchParams(r.body).get('subject_token')
  );
  assert.deepEqual(forms, [first, refreshed]);
});

test('treats another user presenting a session ID as an unknown session', async (t) => {
  const env = await setup(t);
  const alice = await env.sign({ sub: 'alice' });
  const bob = await env.sign({ sub: 'bob' });
  const sessionId = await openSession(env, alice);

  const stolen = await callTool(env, bob, sessionId);
  assert.equal(stolen.reply.status, 404, stolen.reply.body);
  assert.match(stolen.reply.body, /Session not found/);
  assert.equal(env.argocdRequests.length, 0);
  assert.equal(exchangesOf(env, env.tokenRequests).length, 0);

  // Alice still has it.
  const own = await callTool(env, alice, sessionId);
  assert.equal(own.rpc?.result?.isError, false);
  assert.equal(env.argocdRequests.length, 1);

  // And bob cannot read or close it through the session endpoints either.
  for (const method of ['GET', 'DELETE']) {
    const reply = await send(env.mcpPort, {
      method,
      headers: mcpHeaders(env.mcpPort, bob, sessionId)
    });
    assert.equal(reply.status, 404, method);
  }
});

test('an evicted session answers 404, so the client initializes again', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const oldest = await openSession(env, token);
  for (let i = 0; i < 20; i++) await openSession(env, token);

  const evicted = await callTool(env, token, oldest);
  assert.equal(evicted.reply.status, 404, evicted.reply.body);
  for (const method of ['GET', 'DELETE']) {
    const reply = await send(env.mcpPort, {
      method,
      headers: mcpHeaders(env.mcpPort, token, oldest)
    });
    assert.equal(reply.status, 404, method);
  }
});

test('a request without a session ID is still a 400', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const post = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token),
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.equal(post.status, 400, post.body);
  for (const method of ['GET', 'DELETE']) {
    const reply = await send(env.mcpPort, { method, headers: mcpHeaders(env.mcpPort, token) });
    assert.equal(reply.status, 400, method);
  }
});

test('re-exchanges once and retries when ArgoCD rejects the exchanged token', async (t) => {
  const env = await setup(t);
  env.state.rejectArgocdTokens.add('argocd-token-1');
  const token = await env.sign();
  const sessionId = await openSession(env, token);

  const result = await callTool(env, token, sessionId);
  assert.equal(result.rpc?.result?.isError, false, JSON.stringify(result.rpc));
  assert.equal(env.state.exchangeCount, 2);
  assert.deepEqual(authHeaderSeen(env), ['Bearer argocd-token-1', 'Bearer argocd-token-2']);

  // The fresh token is the cached one from now on.
  await callTool(env, token, sessionId);
  assert.equal(env.state.exchangeCount, 2);
  assert.equal(authHeaderSeen(env)[2], 'Bearer argocd-token-2');
});

test('does not retry forever when ArgoCD keeps rejecting', async (t) => {
  const env = await setup(t);
  env.state.rejectArgocdTokens.add('argocd-token-1');
  env.state.rejectArgocdTokens.add('argocd-token-2');
  const token = await env.sign();
  const sessionId = await openSession(env, token);

  const result = await callTool(env, token, sessionId);
  assert.equal(result.rpc?.result?.isError, true, JSON.stringify(result.rpc));
  assert.match(result.rpc?.result?.content?.[0]?.text, /ArgoCD answered 401/);
  assert.equal(env.argocdRequests.length, 2);
  assert.equal(env.state.exchangeCount, 2);
});

test('refuses an argocdBaseUrl argument that points elsewhere', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const sessionId = await openSession(env, token);

  const result = await callTool(env, token, sessionId, { argocdBaseUrl: env.otherUrl });
  assert.equal(result.rpc?.result?.isError, true);
  assert.match(result.rpc?.result?.content?.[0]?.text, /not allowed/);
  assert.equal(env.otherRequests.length, 0);
  assert.equal(env.argocdRequests.length, 0);
  assert.equal(env.state.exchangeCount, 0);
});

test('ignores x-argocd-base-url and x-argocd-api-token headers', async (t) => {
  const env = await setup(t);
  const token = await env.sign();
  const extra = { 'x-argocd-base-url': env.otherUrl, 'x-argocd-api-token': 'static-secret' };
  const sessionId = await openSession(env, token, extra);

  const result = await callTool(env, token, sessionId, {}, extra);
  assert.equal(result.rpc?.result?.isError, false, JSON.stringify(result.rpc));
  assert.equal(env.otherRequests.length, 0);
  assert.deepEqual(authHeaderSeen(env), ['Bearer argocd-token-1']);
});

test('reports a refused exchange without leaking tokens', async (t) => {
  const env = await setup(t);
  env.state.exchangeStatus = 403;
  const token = await env.sign();
  const sessionId = await openSession(env, token);

  const result = await callTool(env, token, sessionId);
  assert.equal(result.rpc?.result?.isError, true);
  const text: string = result.rpc?.result?.content?.[0]?.text;
  assert.match(text, /refused/);
  assert.ok(!text.includes(token));
  assert.equal(env.argocdRequests.length, 0);
});

test('works in stateless mode, exchanging per request', async (t) => {
  const env = await setup(t, { stateless: true });
  const token = await env.sign();
  await send(env.mcpPort, { headers: mcpHeaders(env.mcpPort, token), body: initializeBody });
  const reply = await send(env.mcpPort, {
    headers: mcpHeaders(env.mcpPort, token),
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'list_applications', arguments: {} }
    }
  });
  assert.equal(reply.status, 200, reply.body);
  assert.equal(parseRpc(reply.body).result.isError, false);
  assert.deepEqual(authHeaderSeen(env), ['Bearer argocd-token-1']);
});

test('OAuth lets a non-loopback bind through without MCP_AUTH_TOKEN', () => {
  const oauth = {
    verifier: { verifyAccessToken: async () => ({}) as never },
    resourceMetadataUrl: 'x'
  };
  assert.doesNotThrow(() => resolveListenerSecurity({ port: 0, bindAddress: '0.0.0.0', oauth }));
  assert.throws(() => resolveListenerSecurity({ port: 0, bindAddress: '0.0.0.0' }));
});

test('OAuth together with MCP_AUTH_TOKEN is refused', () => {
  const oauth = {
    verifier: { verifyAccessToken: async () => ({}) as never },
    resourceMetadataUrl: 'x'
  };
  assert.throws(
    () => resolveListenerSecurity({ port: 0, authToken: 'secret', oauth }),
    /both authenticate/
  );
});
