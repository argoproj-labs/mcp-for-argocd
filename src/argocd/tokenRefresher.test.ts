import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenRefresher, type TokenRefreshResult } from './tokenRefresher.js';

// Build a JWT with a given exp (Unix timestamp). Only the payload matters here.
const makeToken = (exp: number | undefined): string => {
  const payload = Buffer.from(JSON.stringify({ exp, iss: 'https://dex.example.com' })).toString(
    'base64url'
  );
  return `header.${payload}.sig`;
};

const TOKEN_EXPIRES_FAR = makeToken(Math.floor(Date.now() / 1000) + 3600); // 1h from now
const TOKEN_EXPIRED = makeToken(Math.floor(Date.now() / 1000) - 10); // already expired
const TOKEN_NO_EXP = makeToken(undefined);

const noopUpdateConfig = () => {};

const makeRefresher = (opts: {
  performRefresh: (
    baseUrl: string,
    currentToken: string,
    refreshToken: string
  ) => Promise<TokenRefreshResult>;
  updateConfig?: (contextName: string, authToken: string, refreshToken?: string) => void;
}) =>
  new TokenRefresher({
    contextName: 'test-ctx',
    baseUrl: 'https://argocd.example.com',
    refreshToken: 'initial-rt',
    performRefresh: opts.performRefresh,
    updateConfig: opts.updateConfig ?? noopUpdateConfig
  });

// --- forceRefresh ------------------------------------------------------------

test('forceRefresh calls performRefresh and propagates the new token', async () => {
  const refresher = makeRefresher({
    performRefresh: async () => ({ authToken: 'new-token' })
  });

  let received: string | undefined;
  refresher.start(TOKEN_EXPIRES_FAR, (t) => {
    received = t;
  });
  refresher.stop(); // cancel scheduled timer so it doesn't interfere

  await refresher.forceRefresh();

  assert.equal(received, 'new-token');
});

test('forceRefresh rethrows on failure', async () => {
  const refresher = makeRefresher({
    performRefresh: async () => {
      throw new Error('OIDC server down');
    }
  });

  refresher.start(TOKEN_EXPIRES_FAR);
  refresher.stop();

  await assert.rejects(() => refresher.forceRefresh(), /OIDC server down/);
});

test('forceRefresh updates the stored refresh token when provider returns a new one', async () => {
  let usedRefreshToken = '';
  const refresher = makeRefresher({
    performRefresh: async (_baseUrl, _current, rt) => {
      usedRefreshToken = rt;
      return { authToken: 'new-tok', refreshToken: 'rotated-rt' };
    }
  });

  refresher.start(TOKEN_EXPIRES_FAR);
  refresher.stop();

  await refresher.forceRefresh();
  // Second call should use the rotated token
  await refresher.forceRefresh();

  assert.equal(usedRefreshToken, 'rotated-rt');
});

// --- onTokenRefreshed callback -----------------------------------------------

test('onTokenRefreshed is called with the new token on successful forceRefresh', async () => {
  const received: string[] = [];
  const refresher = makeRefresher({
    performRefresh: async () => ({ authToken: 'tok-v2' })
  });

  refresher.start(TOKEN_EXPIRES_FAR, (t) => received.push(t));
  refresher.stop();

  await refresher.forceRefresh();
  assert.deepEqual(received, ['tok-v2']);
});

test('onTokenRefreshed is NOT called when forceRefresh fails', async () => {
  const received: string[] = [];
  const refresher = makeRefresher({
    performRefresh: async () => {
      throw new Error('fail');
    }
  });

  refresher.start(TOKEN_EXPIRES_FAR, (t) => received.push(t));
  refresher.stop();

  await assert.rejects(() => refresher.forceRefresh());
  assert.deepEqual(received, []);
});

// --- updateConfig persistence -----------------------------------------------

test('updateConfig is called with new auth token on refresh', async () => {
  const updates: Array<{ contextName: string; authToken: string; refreshToken?: string }> = [];

  const refresher = makeRefresher({
    performRefresh: async () => ({ authToken: 'new-tok', refreshToken: 'new-rt' }),
    updateConfig: (ctx, auth, rt) => updates.push({ contextName: ctx, authToken: auth, refreshToken: rt })
  });

  refresher.start(TOKEN_EXPIRES_FAR);
  refresher.stop();
  await refresher.forceRefresh();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextName, 'test-ctx');
  assert.equal(updates[0].authToken, 'new-tok');
  assert.equal(updates[0].refreshToken, 'new-rt');
});

// --- scheduling: fallback interval when exp is absent -----------------------

test('stop() cancels a scheduled timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let called = false;
  const refresher = makeRefresher({
    performRefresh: async () => {
      called = true;
      return { authToken: 'x' };
    }
  });

  refresher.start(TOKEN_NO_EXP);
  refresher.stop();
  t.mock.timers.tick(60_000);

  assert.equal(called, false);
});

// --- scheduling: exponential backoff ----------------------------------------

test('doRefresh uses exponential backoff after repeated failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Token that's already expired -> msUntilRefresh = 0, fires immediately
  let callCount = 0;
  const refresher = makeRefresher({
    performRefresh: async () => {
      callCount++;
      throw new Error('fail');
    }
  });

  const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

  refresher.start(TOKEN_EXPIRED);

  // First call fires immediately (msUntilRefresh = 0)
  t.mock.timers.tick(0);
  await flushAsync();
  assert.equal(callCount, 1);

  // After 1 failure: backoff = 2^1 * 5000 = 10_000ms
  t.mock.timers.tick(10_000);
  await flushAsync();
  assert.equal(callCount, 2);

  // After 2 failures: backoff = 2^2 * 5000 = 20_000ms
  t.mock.timers.tick(20_000);
  await flushAsync();
  assert.equal(callCount, 3);

  refresher.stop();
});

test('doRefresh resets failureCount after success so next failure uses 10s backoff not 40s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Fail twice (failureCount -> 2, last backoff = 20s), then succeed, then fail once.
  // If failureCount resets to 0 after success, the next failure uses backoff = 10s.
  // If it does NOT reset, the next failure would use backoff = 40s (2^3 * 5s),
  // and tick(10_000) below would not fire.
  let callCount = 0;
  let failsLeft = 2;

  const refresher = makeRefresher({
    performRefresh: async () => {
      callCount++;
      if (failsLeft > 0) {
        failsLeft--;
        throw new Error('fail');
      }
      // Return an already-expired token so scheduleNext fires at delay=0
      return { authToken: TOKEN_EXPIRED };
    }
  });

  const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

  refresher.start(TOKEN_EXPIRED);

  // Call 1: fail -> failureCount=1, backoff=10s
  t.mock.timers.tick(0);
  await flushAsync();
  assert.equal(callCount, 1);

  // Call 2: fail -> failureCount=2, backoff=20s
  t.mock.timers.tick(10_000);
  await flushAsync();
  assert.equal(callCount, 2);

  // Call 3: succeed -> failureCount resets to 0, scheduleNext(TOKEN_EXPIRED) -> 0ms timer
  t.mock.timers.tick(20_000);
  await flushAsync();
  assert.equal(callCount, 3);

  // Call 4: fail again — failureCount should be 1 (reset), backoff = 10s
  failsLeft = 1;
  t.mock.timers.tick(0); // fire the 0ms timer set by scheduleNext after success
  await flushAsync();
  assert.equal(callCount, 4);

  // tick(10s): if failureCount reset -> fires; if not reset -> would need 40s -> would NOT fire
  t.mock.timers.tick(10_000);
  await flushAsync();
  assert.equal(callCount, 5);

  refresher.stop();
});
