import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  applyListenerSecurity,
  canonicalizeBindAddress,
  isLoopbackAddress,
  normalizeBindAddress,
  resolveAllowedHostnames,
  resolveAllowedOrigins,
  resolveListenerSecurity,
  type ListenerSecurity
} from './security.js';

// The listener's exposure boundary: what it binds, which Host and Origin values
// it accepts, whether it demands an inbound token, and that a configuration it
// cannot honour fails at startup. Each test name states the invariant.

const PORT = 3000;

test('the default bind address is loopback and needs no inbound credential', () => {
  const security = resolveListenerSecurity({ port: PORT });
  assert.equal(security.bindAddress, '127.0.0.1');
  assert.equal(security.authToken, undefined);
  assert.equal(security.validateHostHeader, true);
  assert.deepEqual(security.allowedHostnames.sort(), ['127.0.0.1', '[::1]', 'localhost']);
});

test('binding past loopback without inbound auth is refused', () => {
  assert.throws(
    () => resolveListenerSecurity({ bindAddress: '0.0.0.0', port: PORT }),
    /Refusing to bind to 0\.0\.0\.0/
  );
  assert.throws(
    () => resolveListenerSecurity({ bindAddress: '192.168.1.10', port: PORT }),
    /MCP_AUTH_TOKEN/
  );
});

test('binding past loopback is allowed with an inbound token or an explicit ack', () => {
  const withToken = resolveListenerSecurity({
    bindAddress: '0.0.0.0',
    port: PORT,
    authToken: 'inbound-secret'
  });
  assert.equal(withToken.bindAddress, '0.0.0.0');
  assert.equal(withToken.authToken, 'inbound-secret');

  const acked = resolveListenerSecurity({
    bindAddress: '0.0.0.0',
    port: PORT,
    allowUnauthenticated: true
  });
  assert.equal(acked.authToken, undefined);
});

test('a set-but-empty MCP_AUTH_TOKEN is a startup error, not "no auth"', () => {
  // An unexpanded '${VAR}' in compose, or a k8s secret key that resolved to
  // nothing. Treating it as unset would disable the bearer check while the
  // operator believes it is enforced.
  for (const authToken of ['', '   ']) {
    assert.throws(
      () => resolveListenerSecurity({ port: PORT, authToken }),
      /MCP_AUTH_TOKEN is set but empty/
    );
  }
});

test('surrounding whitespace in MCP_AUTH_TOKEN is stripped, inner whitespace is fatal', () => {
  // A secret delivered by `$(cat token)`, a k8s --from-file secret, or a YAML block
  // scalar arrives with a trailing newline. Keeping it would 401 every request
  // forever, and the correct value would be unsendable: CR/LF cannot appear in a
  // header at all, and RFC 6750 token68 has no room for a space.
  assert.equal(
    resolveListenerSecurity({ port: PORT, authToken: 'inbound-secret\n' }).authToken,
    'inbound-secret'
  );
  for (const authToken of ['inbound secret', 'inbound\tsecret', 'a\nb']) {
    assert.throws(
      () => resolveListenerSecurity({ port: PORT, authToken }),
      /MCP_AUTH_TOKEN contains whitespace/,
      `${JSON.stringify(authToken)} is rejected`
    );
  }
});

test('a bind address the resolver and the URL parser could read differently is refused', () => {
  // WHATWG URL reads the first as userinfo plus a loopback host and the second as
  // octal for 127.0.0.1, while getaddrinfo resolves neither that way. Accepting
  // them would let the loopback decision be made about one address while the
  // socket binds another.
  // An empty --bind-address/MCP_BIND_ADDRESS is absent rather than invalid: it
  // falls back to the loopback default, which is the safe direction.
  assert.equal(resolveListenerSecurity({ bindAddress: '', port: PORT }).bindAddress, '127.0.0.1');
  for (const bindAddress of [
    'evil.example@127.0.0.1',
    '0177.0.0.1',
    '127.1',
    '*',
    '${MCP_BIND_ADDRESS}',
    ' '
  ]) {
    assert.throws(
      () => resolveListenerSecurity({ bindAddress, port: PORT }),
      /Invalid --bind-address value/,
      `${JSON.stringify(bindAddress)} is refused`
    );
  }
});

test('canonicalizeBindAddress accepts every real spelling and lower-cases it', () => {
  for (const [host, expected] of [
    ['127.0.0.1', '127.0.0.1'],
    ['LocalHost', 'localhost'],
    ['  0.0.0.0  ', '0.0.0.0'],
    ['[::1]', '[::1]'],
    ['::', '::'],
    ['MCP.Internal.Example.COM', 'mcp.internal.example.com']
  ]) {
    assert.equal(canonicalizeBindAddress(host), expected);
  }
});

test('ARGOCD_API_TOKEN never satisfies the inbound requirement', () => {
  // Guards against a future env fallback creeping into resolveListenerSecurity:
  // the outbound ArgoCD credential must not make an exposed bind look authorized.
  process.env.ARGOCD_API_TOKEN = 'outbound-only';
  try {
    assert.throws(
      () => resolveListenerSecurity({ bindAddress: '0.0.0.0', port: PORT }),
      /Refusing to bind/
    );
  } finally {
    delete process.env.ARGOCD_API_TOKEN;
  }
});

test('Host validation is off on an exposed bind with no allow list, and on with one', () => {
  // The name a remote client legitimately uses is unknown, so a loopback-only
  // Host allow list would reject every real request. Origin validation and the
  // inbound credential still apply; see the ListenerSecurity.validateHostHeader note.
  const noAllowList = resolveListenerSecurity({
    bindAddress: '0.0.0.0',
    port: PORT,
    authToken: 'inbound-secret'
  });
  assert.equal(noAllowList.validateHostHeader, false);

  const withAllowList = resolveListenerSecurity({
    bindAddress: '0.0.0.0',
    port: PORT,
    authToken: 'inbound-secret',
    allowedHostHeaders: ['mcp.internal']
  });
  assert.equal(withAllowList.validateHostHeader, true);
  assert.ok(withAllowList.allowedHostnames.includes('mcp.internal'));
});

test('the Host allow list covers loopback, the bind host, and operator additions', () => {
  const names = resolveAllowedHostnames('192.168.1.10', [
    'mcp.internal',
    'https://ide.example:8443'
  ]);
  for (const expected of ['127.0.0.1', 'localhost', '[::1]', '192.168.1.10', 'mcp.internal']) {
    assert.ok(names.includes(expected), `${expected} is allowed`);
  }
  // A full origin is reduced to its hostname, matching the port-agnostic Host check.
  assert.ok(names.includes('ide.example'));
});

test('an IPv6 hostname survives the allow list unchanged', () => {
  // WHATWG URL keeps the brackets around an IPv6 hostname. Re-adding them would
  // store '[[::1]]' and silently reject every request from that host.
  const names = resolveAllowedHostnames('[::1]', ['[2001:db8::5]']);
  assert.ok(names.includes('[::1]'));
  assert.ok(names.includes('[2001:db8::5]'));
  assert.ok(!names.some((n) => n.startsWith('[[')));
});

test('an unparseable --allowed-host-header is a startup error, not a silent drop', () => {
  // Dropping it would leave Host validation enabled with an allow list that never
  // contains the operator's entry, 403-ing every legitimate request.
  assert.throws(
    () => resolveAllowedHostnames('0.0.0.0', ['2001:db8::5']),
    /Invalid --allowed-host-header value: 2001:db8::5/
  );
});

test('an --allowed-host-header that parses but can never match is a startup error', () => {
  // The WHATWG URL host parser accepts all of these, so parseability alone is too
  // weak a test. Each would be stored as a single unmatchable "hostname" while
  // switching Host validation on — an operator writing '*' for "allow any" would
  // 403 every legitimate request instead.
  for (const value of ['*', 'a.example,b.example', '${HOST}', 'mcp.internal.', 'has space']) {
    assert.throws(
      () => resolveAllowedHostnames('0.0.0.0', [value]),
      /Invalid --allowed-host-header value/,
      `${JSON.stringify(value)} is refused`
    );
  }
});

test('an --allowed-host-header the resolver and the URL parser could read differently is refused', () => {
  // Same policy the bind host gets in canonicalizeBindAddress: WHATWG URL reads
  // 'evil.example@127.0.0.1' as userinfo plus a loopback host, '0177.0.0.1' and
  // '127.1' as spellings of 127.0.0.1, and percent-decodes '%2e'. Reconciling
  // any of these silently would drop the operator's literal entry — reduced to
  // 127.0.0.1 it is already in the default set — so Host validation stays on
  // with an allow list that never contains what they asked for, and startup
  // gives no clue why later requests 403.
  for (const value of ['evil.example@127.0.0.1', '0177.0.0.1', '127.1', 'a%2eexample.com']) {
    assert.throws(
      () => resolveAllowedHostnames('0.0.0.0', [value]),
      /Invalid --allowed-host-header value/,
      `${JSON.stringify(value)} is refused`
    );
  }
});

test('an --allowed-host-header carrying a path, query, or fragment is refused', () => {
  // A Host header is an authority, never a URL with a path, so an entry that has
  // one was not written as the name it parses to. Ignoring the extra text would
  // also re-open the rewrite above from the other side: the rewritten authority of
  // '0177.0.0.1/127.0.0.1' is 0177.0.0.1, while the text the check compares
  // against contains '127.0.0.1' in the path.
  for (const value of [
    '0177.0.0.1/127.0.0.1',
    'http://0177.0.0.1/127.0.0.1',
    '127.0.0.1/evil',
    'mcp.internal?x=1',
    'mcp.internal#f'
  ]) {
    assert.throws(
      () => resolveAllowedHostnames('0.0.0.0', [value]),
      /Invalid --allowed-host-header value/,
      `${JSON.stringify(value)} is refused`
    );
  }
});

test('an --allowed-origin that parses but can never match is a startup error', () => {
  // 'https://a.example,https://b.example' otherwise collapses to the single
  // nonsense origin 'https://a.example,https'.
  for (const value of ['https://a.example,https://b.example', 'https://*', 'null', 'file:///tmp']) {
    assert.throws(
      () => resolveAllowedOrigins(PORT, [value]),
      /Invalid --allowed-origin value/,
      `${JSON.stringify(value)} is refused`
    );
  }
});

test('an origin with a non-http scheme can be allow-listed', () => {
  // URL.origin serializes to the string 'null' for every non-special scheme, so
  // matching on it alone locks out editor and desktop clients — a VS Code webview,
  // a browser extension, an Electron shell — with no way to allow them.
  const origins = resolveAllowedOrigins(PORT, [
    'vscode-webview://abc123',
    'chrome-extension://kkljfdmelbpgcnkhfnnbdgjbjmhllbcm'
  ]);
  assert.ok(origins.includes('vscode-webview://abc123'));
  assert.ok(origins.includes('chrome-extension://kkljfdmelbpgcnkhfnnbdgjbjmhllbcm'));
});

test('a wildcard bind contributes no hostname to the allow list', () => {
  for (const wildcard of ['0.0.0.0', '::', '[::]']) {
    assert.deepEqual(resolveAllowedHostnames(wildcard).sort(), ['127.0.0.1', '[::1]', 'localhost']);
  }
});

test('isLoopbackAddress recognises every loopback spelling, bracketed or not', () => {
  // 127.0.0.2 and beyond: the whole 127.0.0.0/8 block is loopback (RFC 5735).
  for (const host of [
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.0.0.2',
    '127.255.0.1',
    '::1',
    '[::1]'
  ]) {
    assert.equal(isLoopbackAddress(host), true, `${host} is loopback`);
  }
  for (const host of [
    '0.0.0.0',
    '::',
    '[::]',
    '192.168.1.10',
    '128.0.0.1',
    '1270.0.0.1',
    '127.0.0.1.evil.example',
    'mcp.internal'
  ]) {
    assert.equal(isLoopbackAddress(host), false, `${host} is not loopback`);
  }
});

test('a non-default 127/8 bind is loopback: no inbound credential required', () => {
  const security = resolveListenerSecurity({ bindAddress: '127.0.0.2', port: PORT });
  assert.equal(security.bindAddress, '127.0.0.2');
  assert.equal(security.validateHostHeader, true);
  // The bind address itself joins the Host allow list, so requests addressed to
  // it are not rejected.
  assert.ok(security.allowedHostnames.includes('127.0.0.2'));
});

test('a bracketed bind address is unwrapped for the socket', () => {
  // net.listen() takes a bare address; the brackets are a Host-header spelling.
  assert.equal(normalizeBindAddress('[::1]'), '::1');
  assert.equal(normalizeBindAddress('::1'), '::1');
  assert.equal(normalizeBindAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveListenerSecurity({ bindAddress: '[::1]', port: PORT }).bindAddress, '::1');
});

test('the Origin allow list is port- and scheme-specific', () => {
  const origins = resolveAllowedOrigins(3000, ['https://ide.example']);
  assert.ok(origins.includes('http://localhost:3000'));
  assert.ok(origins.includes('https://localhost:3000'));
  assert.ok(origins.includes('http://[::1]:3000'));
  assert.ok(origins.includes('https://ide.example'));
  // A different port on an allowed hostname is a different origin.
  assert.ok(!origins.includes('http://localhost:9999'));
});

test('an unparseable --allowed-origin is a startup error', () => {
  assert.throws(() => resolveAllowedOrigins(PORT, ['http://']), /Invalid --allowed-origin/);
});

// Reserve a port the guarded app can bind, so the Origin allow list (which is
// port-specific) matches the port the test actually talks to.
const freePort = async (): Promise<number> => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

// Start a protected app on a loopback port. The single guarded route stands in
// for /mcp: reaching it means every protection let the request through.
const startGuardedApp = async (
  build: (port: number) => ListenerSecurity
): Promise<{ port: number; close: () => Promise<void> }> => {
  const port = await freePort();
  const app = express();
  applyListenerSecurity(app, build(port));
  app.post('/mcp', (_req, res) => {
    res.status(200).json({ reached: true });
  });

  const server = app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
};

// Issue a request with arbitrary Host/Origin headers. node:http is used rather
// than fetch because fetch refuses to let a caller set the Host header, which is
// exactly what a DNS-rebinding victim's browser would send.
const request = (
  port: number,
  headers: Record<string, string>
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end('{}');
  });

const loopbackDefaults = (port: number) => resolveListenerSecurity({ port });

test('an allowed Host with no Origin reaches the route', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    const res = await request(port, {
      host: `localhost:${port}`,
      'content-type': 'application/json'
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-powered-by'], undefined, 'framework is not advertised');
  } finally {
    await close();
  }
});

test('a Host outside the allow list is rejected', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    // What an attacker on the same LAN sends when addressing the machine's own IP.
    const res = await request(port, {
      host: '192.168.1.10:3000',
      'content-type': 'application/json'
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /Invalid Host/);
  } finally {
    await close();
  }
});

test('a cross-origin request is rejected even when the Host is forged to localhost', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    const res = await request(port, {
      host: `localhost:${port}`,
      origin: 'https://evil.example',
      'content-type': 'application/json'
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /Invalid Origin/);
  } finally {
    await close();
  }
});

test('a co-resident page on another loopback port is a different origin', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    // Another dev server on this machine (webpack, storybook, some tool's UI) is
    // not the same origin, and an XSS there must not reach the MCP listener.
    const res = await request(port, {
      host: `localhost:${port}`,
      origin: `http://localhost:${port + 1}`,
      'content-type': 'application/json'
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /Invalid Origin/);
  } finally {
    await close();
  }
});

test('an opaque Origin is rejected', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    // Sent by a sandboxed iframe or a file:// page.
    const res = await request(port, {
      host: `localhost:${port}`,
      origin: 'null',
      'content-type': 'application/json'
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test('a same-origin browser request reaches the route', async () => {
  const { port, close } = await startGuardedApp(loopbackDefaults);
  try {
    const res = await request(port, {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      'content-type': 'application/json'
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('an explicitly allowed origin reaches the route', async () => {
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({ port, allowedOrigins: ['https://ide.example'] })
  );
  try {
    const res = await request(port, {
      host: `localhost:${port}`,
      origin: 'https://ide.example',
      'content-type': 'application/json'
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('an exposed listener still rejects cross-origin requests', async () => {
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({ bindAddress: '0.0.0.0', port, allowUnauthenticated: true })
  );
  try {
    // Host validation is off here, so this proves Origin validation alone keeps a
    // malicious web page out of a deliberately exposed listener.
    const evil = await request(port, {
      host: 'mcp.internal:3000',
      origin: 'https://evil.example',
      'content-type': 'application/json'
    });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /Invalid Origin/);

    const noOrigin = await request(port, {
      host: 'mcp.internal:3000',
      'content-type': 'application/json'
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    await close();
  }
});

test('an exposed listener with an allow list enforces Host validation', async () => {
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({
      bindAddress: '0.0.0.0',
      port,
      allowUnauthenticated: true,
      allowedHostHeaders: ['mcp.internal']
    })
  );
  try {
    const allowed = await request(port, {
      host: 'mcp.internal:3000',
      'content-type': 'application/json'
    });
    assert.equal(allowed.status, 200);

    const other = await request(port, {
      host: 'other.internal:3000',
      'content-type': 'application/json'
    });
    assert.equal(other.status, 403);
    assert.match(other.body, /Invalid Host/);
  } finally {
    await close();
  }
});

test('a configured inbound token is required on every request', async () => {
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({ bindAddress: '0.0.0.0', port, authToken: 'inbound-secret' })
  );
  const baseHeaders = () => ({ host: `localhost:${port}`, 'content-type': 'application/json' });
  try {
    const missing = await request(port, baseHeaders());
    assert.equal(missing.status, 401);
    assert.match(missing.body, /Missing or invalid inbound bearer token/);

    const wrong = await request(port, { ...baseHeaders(), authorization: 'Bearer wrong-secret' });
    assert.equal(wrong.status, 401);

    // A same-length token rules out the comparison short-circuiting on length alone.
    const sameLength = await request(port, {
      ...baseHeaders(),
      authorization: 'Bearer inbound-secrXt'
    });
    assert.equal(sameLength.status, 401);

    // Not a bearer credential at all.
    const basic = await request(port, { ...baseHeaders(), authorization: 'Basic aW5ib3VuZA==' });
    assert.equal(basic.status, 401);

    const correct = await request(port, {
      ...baseHeaders(),
      authorization: 'Bearer inbound-secret'
    });
    assert.equal(correct.status, 200);

    // RFC 9110 makes the scheme case-insensitive and tolerates extra whitespace.
    for (const header of ['bearer inbound-secret', 'BEARER  inbound-secret']) {
      const res = await request(port, { ...baseHeaders(), authorization: header });
      assert.equal(res.status, 200, `"${header}" is accepted`);
    }
  } finally {
    await close();
  }
});

test('a trimmed MCP_AUTH_TOKEN is the value the listener actually accepts', async () => {
  // Pairs with the whitespace-stripping test above: proves the trim happens before
  // the comparison rather than only in the returned struct.
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({ port, authToken: '  inbound-secret\n' })
  );
  try {
    const res = await request(port, {
      host: `localhost:${port}`,
      authorization: 'Bearer inbound-secret',
      'content-type': 'application/json'
    });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('the allow lists are not an enumeration oracle for an unauthenticated caller', async () => {
  // With the credential checked last, a caller with no token got 403 (echoing the
  // value) for a Host or Origin outside the allow list and 401 for one inside it,
  // so differencing the two statuses enumerated both lists — and the internal
  // hostnames in them — before ever presenting a token.
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({
      port,
      authToken: 'inbound-secret',
      allowedHostHeaders: ['mcp.internal.example.com'],
      allowedOrigins: ['https://ide.example']
    })
  );
  try {
    const cases: Record<string, string>[] = [
      { host: 'other.internal:3000' },
      { host: 'mcp.internal.example.com:3000' },
      { host: `localhost:${port}`, origin: 'https://evil.example' },
      { host: `localhost:${port}`, origin: 'https://ide.example' }
    ];
    for (const headers of cases) {
      const res = await request(port, { ...headers, 'content-type': 'application/json' });
      assert.equal(res.status, 401, `${JSON.stringify(headers)} is answered 401, not 403`);
      assert.doesNotMatch(res.body, /internal\.example\.com|ide\.example/);
    }
  } finally {
    await close();
  }
});

test('an allow-listed non-http origin reaches the route', async () => {
  const { port, close } = await startGuardedApp((port) =>
    resolveListenerSecurity({ port, allowedOrigins: ['vscode-webview://abc123'] })
  );
  try {
    const allowed = await request(port, {
      host: `localhost:${port}`,
      origin: 'vscode-webview://abc123',
      'content-type': 'application/json'
    });
    assert.equal(allowed.status, 200);

    // Another webview id is a different origin, so allow-listing one does not
    // admit every opaque-origin client.
    const other = await request(port, {
      host: `localhost:${port}`,
      origin: 'vscode-webview://def456',
      'content-type': 'application/json'
    });
    assert.equal(other.status, 403);
  } finally {
    await close();
  }
});
