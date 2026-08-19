import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, SignJWT, JWTVerifyGetKey } from 'jose';
import { Request, Response } from 'express';
import { AuthConfig, authConfigFromEnv, createAuthMiddleware } from './auth.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUDIENCE = 'test-audience-tag';
const HEADER = 'cf-access-jwt-assertion';

const config: AuthConfig = {
  jwksUrl: 'https://team.cloudflareaccess.com/cdn-cgi/access/certs',
  issuer: ISSUER,
  audience: AUDIENCE,
  header: HEADER
};

// One signing key pair for the suite; `getKey` stands in for the remote JWKS.
const keys = await generateKeyPair('RS256');
const getKey: JWTVerifyGetKey = async () => keys.publicKey;

const signToken = async (
  overrides: {
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    omitExp?: boolean;
    key?: CryptoKey;
  } = {}
): Promise<string> => {
  const jwt = new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE);
  if (!overrides.omitExp) jwt.setExpirationTime(overrides.expiresIn ?? '5m');
  return jwt.sign(overrides.key ?? keys.privateKey);
};

// Minimal req/res doubles; run the middleware and report what it did.
const run = async (
  headers: Record<string, string>,
  middlewareConfig: AuthConfig = config
): Promise<{ nextCalled: boolean; status: number | null }> => {
  const req = { headers, method: 'POST', path: '/mcp' } as unknown as Request;
  let status: number | null = null;
  let nextCalled = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    send() {
      return this;
    }
  } as unknown as Response;
  await createAuthMiddleware(middlewareConfig, getKey)(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, status };
};

// --- Middleware: accept/reject ---------------------------------------------

test('accepts a valid token', async () => {
  const result = await run({ [HEADER]: await signToken() });
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
});

test('accepts a valid ES256 token (Google IAP)', async () => {
  const esKeys = await generateKeyPair('ES256');
  const token = await new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(esKeys.privateKey);
  const req = { headers: { [HEADER]: token }, method: 'POST', path: '/mcp' } as unknown as Request;
  let nextCalled = false;
  const res = {
    status() {
      return this;
    },
    send() {
      return this;
    }
  } as unknown as Response;
  await createAuthMiddleware(config, async () => esKeys.publicKey)(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test('rejects a request without the token header', async () => {
  const result = await run({});
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects a token signed by a different key', async () => {
  const otherKeys = await generateKeyPair('RS256');
  const result = await run({ [HEADER]: await signToken({ key: otherKeys.privateKey }) });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects a token with the wrong audience', async () => {
  const result = await run({ [HEADER]: await signToken({ audience: 'another-app' }) });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects a token with the wrong issuer', async () => {
  const result = await run({
    [HEADER]: await signToken({ issuer: 'https://evil.example.com' })
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects an expired token', async () => {
  const result = await run({ [HEADER]: await signToken({ expiresIn: '-5m' }) });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects a token without an exp claim', async () => {
  const result = await run({ [HEADER]: await signToken({ omitExp: true }) });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('rejects an unsigned alg=none token with valid-looking claims', async () => {
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const forged = `${b64({ alg: 'none' })}.${b64({
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: 'attacker@example.com'
  })}.`;
  const result = await run({ [HEADER]: forged });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 401);
});

test('strips the Bearer prefix when using the authorization header', async () => {
  const bearerConfig = { ...config, header: 'authorization' };
  const result = await run({ authorization: `Bearer ${await signToken()}` }, bearerConfig);
  assert.equal(result.nextCalled, true);
});

// --- authConfigFromEnv ------------------------------------------------------

test('authConfigFromEnv returns null when no auth vars are set', () => {
  assert.equal(authConfigFromEnv({}), null);
});

test('authConfigFromEnv parses a full config and defaults the header', () => {
  const parsed = authConfigFromEnv({
    MCP_AUTH_JWKS_URL: config.jwksUrl,
    MCP_AUTH_ISSUER: ISSUER,
    MCP_AUTH_AUDIENCE: AUDIENCE
  });
  assert.deepEqual(parsed, { ...config, header: 'authorization' });
});

test('authConfigFromEnv lowercases a custom header', () => {
  const parsed = authConfigFromEnv({
    MCP_AUTH_JWKS_URL: config.jwksUrl,
    MCP_AUTH_ISSUER: ISSUER,
    MCP_AUTH_AUDIENCE: AUDIENCE,
    MCP_AUTH_TOKEN_HEADER: 'CF-Access-Jwt-Assertion'
  });
  assert.equal(parsed?.header, 'cf-access-jwt-assertion');
});

test('authConfigFromEnv fails closed on partial config', () => {
  assert.throws(
    () => authConfigFromEnv({ MCP_AUTH_JWKS_URL: config.jwksUrl }),
    /missing MCP_AUTH_ISSUER, MCP_AUTH_AUDIENCE/
  );
});
