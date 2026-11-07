import assert from 'node:assert/strict';
import { test } from 'node:test';
import yargs from 'yargs';
import { envBoolean, envPort, httpOptions, listenerOptions } from './cmd.js';

const ENV_VARS = ['MCP_PORT', 'MCP_STATELESS', 'MCP_ALLOW_UNAUTHENTICATED'] as const;

// Helper: run `fn` with the given listener env vars set and every other one
// unset, then restore the originals. The option defaults read process.env when
// the options are built, so `fn` must build them itself.
const withEnv = <R>(env: Partial<Record<(typeof ENV_VARS)[number], string>>, fn: () => R): R => {
  const saved = ENV_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of ENV_VARS) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

// .fail() turns a failed check into a thrown error instead of process.exit().
const parseHttp = (args: string[]) =>
  httpOptions(yargs(args))
    .fail((msg, err) => {
      throw err ?? new Error(msg);
    })
    .parseSync();

// --- envBoolean / envPort ------------------------------------------------

test('envBoolean is true only for "true", ignoring case and whitespace', () => {
  assert.equal(envBoolean('true'), true);
  assert.equal(envBoolean(' TRUE\n'), true);
  for (const value of [undefined, '', 'false', '1', 'yes', 'on']) {
    assert.equal(envBoolean(value), false, `envBoolean(${JSON.stringify(value)})`);
  }
});

test('envPort defaults to 3000 when unset or blank', () => {
  assert.equal(envPort(undefined), 3000);
  assert.equal(envPort(''), 3000);
  assert.equal(envPort('  '), 3000);
});

test('envPort parses a port and returns NaN for anything else', () => {
  assert.equal(envPort('8000'), 8000);
  assert.equal(envPort(' 8000\n'), 8000);
  assert.ok(Number.isNaN(envPort('abc')));
});

// --- Defaults from the environment ---------------------------------------

test('with no flags and no env vars the defaults are unchanged', () => {
  const argv = withEnv({}, () => parseHttp([]));
  assert.equal(argv.port, 3000);
  assert.equal(argv.stateless, false);
  assert.equal(argv.allowUnauthenticated, false);
});

test('env vars set the defaults when no flag is passed', () => {
  const argv = withEnv(
    { MCP_PORT: '8000', MCP_STATELESS: 'true', MCP_ALLOW_UNAUTHENTICATED: 'true' },
    () => parseHttp([])
  );
  assert.equal(argv.port, 8000);
  assert.equal(argv.stateless, true);
  assert.equal(argv.allowUnauthenticated, true);
});

test('a flag on the command line wins over its env var', () => {
  const argv = withEnv(
    { MCP_PORT: '8000', MCP_STATELESS: 'true', MCP_ALLOW_UNAUTHENTICATED: 'true' },
    () => parseHttp(['--port', '4000', '--no-stateless', '--no-allow-unauthenticated'])
  );
  assert.equal(argv.port, 4000);
  assert.equal(argv.stateless, false);
  assert.equal(argv.allowUnauthenticated, false);
});

test('only "true" enables a boolean env var', () => {
  const argv = withEnv({ MCP_STATELESS: '1', MCP_ALLOW_UNAUTHENTICATED: 'yes' }, () =>
    parseHttp([])
  );
  assert.equal(argv.stateless, false);
  assert.equal(argv.allowUnauthenticated, false);
});

test('an invalid MCP_PORT fails the port check instead of falling back', () => {
  for (const value of ['abc', '0', '70000']) {
    assert.throws(
      () => withEnv({ MCP_PORT: value }, () => parseHttp([])),
      /Invalid --port \(or MCP_PORT\) value/,
      `MCP_PORT=${value}`
    );
  }
});

test('the sse transport takes MCP_PORT and MCP_ALLOW_UNAUTHENTICATED too', () => {
  const argv = withEnv({ MCP_PORT: '8000', MCP_ALLOW_UNAUTHENTICATED: 'true' }, () =>
    listenerOptions(yargs([])).parseSync()
  );
  assert.equal(argv.port, 8000);
  assert.equal(argv.allowUnauthenticated, true);
});
