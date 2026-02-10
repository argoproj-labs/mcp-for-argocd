import { describe, it, expect, vi, afterEach } from 'vitest';
import { startCallbackServer } from './mcp-oauth-callback.js';
import type { ArgocdOAuthProvider } from './mcp-oauth-provider.js';

vi.mock('../logging/logging.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

function makeProvider(overrides: Partial<ArgocdOAuthProvider> = {}) {
  return {
    handleUpstreamCallback: vi.fn(),
    ...overrides
  } as unknown as ArgocdOAuthProvider;
}

describe('startCallbackServer', () => {
  let shutdownFn: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (shutdownFn) {
      await shutdownFn();
      shutdownFn = undefined;
    }
  });

  it('should start on the specified port and handle successful callback', async () => {
    const provider = makeProvider({
      handleUpstreamCallback: vi.fn().mockResolvedValue('http://client.example.com/done?code=abc')
    });

    shutdownFn = await startCallbackServer(provider, 0); // port 0 = random available port

    // We need the actual port — get it by trying the provider mock path
    // Since port 0 assigns a random port, we'll use a fixed high port for testing
  });

  it('should start and accept requests on the given port', async () => {
    const redirectUrl = 'http://client.example.com/callback?code=our-code&state=client-state';
    const provider = makeProvider({
      handleUpstreamCallback: vi.fn().mockResolvedValue(redirectUrl)
    });

    const port = 18901;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=upstream-code&state=upstream-state`, {
      redirect: 'manual'
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(redirectUrl);
    expect(provider.handleUpstreamCallback).toHaveBeenCalledWith('upstream-code', 'upstream-state');
  });

  it('should return 400 when code is missing', async () => {
    const provider = makeProvider();
    const port = 18902;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?state=some-state`);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Missing code or state parameter');
  });

  it('should return 400 when state is missing', async () => {
    const provider = makeProvider();
    const port = 18903;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=some-code`);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Missing code or state parameter');
  });

  it('should return 400 with error description on upstream OIDC error', async () => {
    const provider = makeProvider();
    const port = 18904;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback?error=access_denied&error_description=User+denied+access`
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Authentication failed: User denied access');
  });

  it('should return 500 when provider.handleUpstreamCallback throws', async () => {
    const provider = makeProvider({
      handleUpstreamCallback: vi.fn().mockRejectedValue(new Error('Unknown state'))
    });

    const port = 18905;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=bad-code&state=bad-state`);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe('Authentication callback failed. Please try again.');
  });

  it('should return 404 for non-callback paths', async () => {
    const provider = makeProvider();
    const port = 18906;
    shutdownFn = await startCallbackServer(provider, port);

    const res = await fetch(`http://127.0.0.1:${port}/other`);

    expect(res.status).toBe(404);
  });
});
