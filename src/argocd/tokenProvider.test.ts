import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandTokenProvider, StaticTokenProvider } from './tokenProvider.js';

// The command providers under test run real child processes. We use the current
// node binary with `-e` so the tests are hermetic and portable: no shell, no
// external tooling, and the "token" is whatever the inline script prints.
const nodeCmd = (script: string): string[] => [process.execPath, '-e', script];

// Counts how many times a command actually ran by having each run append a
// byte to a scratch file. The file lives in a throwaway temp dir.
const withRunCounter = (): { command: string[]; runs: () => number; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'token-provider-test-'));
  const file = join(dir, 'runs');
  const command = nodeCmd(
    `require('fs').appendFileSync(${JSON.stringify(file)}, 'x'); process.stdout.write('tok-' + process.pid)`
  );
  return {
    command,
    runs: () => {
      try {
        return readFileSync(file, 'utf8').length;
      } catch {
        return 0;
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
};

// --- StaticTokenProvider -------------------------------------------------

test('StaticTokenProvider returns the configured token', async () => {
  const provider = new StaticTokenProvider('static-token');
  assert.equal(await provider.getToken(), 'static-token');
});

test('StaticTokenProvider cannot be refreshed: invalidate reports false', () => {
  const provider = new StaticTokenProvider('static-token');
  assert.equal(provider.invalidate(), false);
});

// --- CommandTokenProvider: happy path ------------------------------------

test('CommandTokenProvider returns the trimmed stdout of the command', async () => {
  const provider = new CommandTokenProvider({
    command: nodeCmd(`process.stdout.write('  cmd-token\\n')`)
  });
  assert.equal(await provider.getToken(), 'cmd-token');
});

test('CommandTokenProvider caches the token within the TTL', async () => {
  const counter = withRunCounter();
  try {
    const provider = new CommandTokenProvider({ command: counter.command, ttlSeconds: 60 });
    const first = await provider.getToken();
    const second = await provider.getToken();
    assert.equal(second, first);
    assert.equal(counter.runs(), 1);
  } finally {
    counter.cleanup();
  }
});

test('CommandTokenProvider re-runs the command once the TTL has elapsed', async () => {
  const counter = withRunCounter();
  try {
    let now = 1_000_000;
    const provider = new CommandTokenProvider(
      { command: counter.command, ttlSeconds: 30 },
      { now: () => now }
    );
    await provider.getToken();
    now += 29_000;
    await provider.getToken();
    assert.equal(counter.runs(), 1, 'still cached just before the TTL');
    now += 2_000;
    await provider.getToken();
    assert.equal(counter.runs(), 2, 'refreshed after the TTL');
  } finally {
    counter.cleanup();
  }
});

test('CommandTokenProvider coalesces concurrent cache misses into one execution', async () => {
  const counter = withRunCounter();
  try {
    const provider = new CommandTokenProvider({ command: counter.command });
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken()
    ]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(counter.runs(), 1);
  } finally {
    counter.cleanup();
  }
});

test('CommandTokenProvider.invalidate drops the cache and reports true', async () => {
  const counter = withRunCounter();
  try {
    const provider = new CommandTokenProvider({ command: counter.command, ttlSeconds: 60 });
    await provider.getToken();
    assert.equal(provider.invalidate(), true);
    await provider.getToken();
    assert.equal(counter.runs(), 2);
  } finally {
    counter.cleanup();
  }
});

test('CommandTokenProvider runs the command without a shell', async () => {
  // If a shell were involved, `$HOME` would be expanded. Passed via execFile it
  // reaches the script verbatim.
  const provider = new CommandTokenProvider({
    command: [process.execPath, '-e', `process.stdout.write(process.argv[1])`, '$HOME']
  });
  assert.equal(await provider.getToken(), '$HOME');
});

// --- CommandTokenProvider: fail closed -----------------------------------

test('CommandTokenProvider rejects when the command prints nothing', async () => {
  const provider = new CommandTokenProvider({ command: nodeCmd('') });
  await assert.rejects(() => provider.getToken(), /produced no output/);
});

test('CommandTokenProvider rejects when the command exits non-zero, including stderr', async () => {
  const provider = new CommandTokenProvider({
    command: nodeCmd(`process.stderr.write('not logged in'); process.exit(3)`)
  });
  await assert.rejects(
    () => provider.getToken(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with code 3/);
      assert.match(error.message, /not logged in/);
      return true;
    }
  );
});

test('CommandTokenProvider rejects when the command cannot be started', async () => {
  const provider = new CommandTokenProvider({ command: ['/nonexistent/token-helper'] });
  await assert.rejects(() => provider.getToken(), /ENOENT/);
});

test('CommandTokenProvider rejects when the command exceeds its timeout', async () => {
  const provider = new CommandTokenProvider({
    command: nodeCmd(`setTimeout(() => {}, 10000)`),
    timeoutSeconds: 0.2
  });
  await assert.rejects(() => provider.getToken(), /timed out after 0.2s/);
});

test('CommandTokenProvider does not cache a failure: the next call re-runs the command', async () => {
  const counter = withRunCounter();
  try {
    // Fails the first time it runs (file has no bytes yet), succeeds afterwards.
    const file = counter.command[2].match(/appendFileSync\((".*?")/)![1];
    const command = nodeCmd(
      `const fs = require('fs'); const first = !fs.existsSync(${file}); fs.appendFileSync(${file}, 'x'); if (first) process.exit(1); process.stdout.write('ok')`
    );
    const provider = new CommandTokenProvider({ command });
    await assert.rejects(() => provider.getToken());
    assert.equal(await provider.getToken(), 'ok');
    assert.equal(counter.runs(), 2);
  } finally {
    counter.cleanup();
  }
});

test('CommandTokenProvider error messages name the command but never its output', async () => {
  const provider = new CommandTokenProvider({
    command: nodeCmd(`process.stdout.write('leaked-secret'); process.exit(1)`)
  });
  await assert.rejects(
    () => provider.getToken(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('leaked-secret'));
      return true;
    }
  );
});

// --- CommandTokenProvider: option validation -----------------------------

test('CommandTokenProvider rejects an empty command', () => {
  assert.throws(() => new CommandTokenProvider({ command: [] }), /tokenCommand/);
});

test('CommandTokenProvider rejects a non-positive TTL or timeout', () => {
  assert.throws(
    () => new CommandTokenProvider({ command: ['x'], ttlSeconds: 0 }),
    /tokenTTLSeconds/
  );
  assert.throws(
    () => new CommandTokenProvider({ command: ['x'], timeoutSeconds: -1 }),
    /tokenCommandTimeoutSeconds/
  );
});

test('CommandTokenProvider.description names the executable only', () => {
  const provider = new CommandTokenProvider({
    command: ['gcloud', 'auth', 'print-identity-token', '--audiences=secret-client-id']
  });
  assert.equal(provider.description, 'command "gcloud"');
});
