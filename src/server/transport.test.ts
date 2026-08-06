import { test } from 'node:test';
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { connectHttpTransport } from './transport.js';

const listening = (server: Server) =>
  new Promise<AddressInfo>((resolve) =>
    server.once('listening', () => resolve(server.address() as AddressInfo))
  );

const closed = (server: Server) => new Promise((resolve) => server.close(resolve));

test('http transport binds all interfaces by default', async () => {
  const server = connectHttpTransport(0);
  const { address, port } = await listening(server);
  assert.notStrictEqual(address, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.strictEqual(res.status, 200);
  await closed(server);
});

test('http transport binds only the given host', async () => {
  const server = connectHttpTransport(0, false, '127.0.0.1');
  const { address, port } = await listening(server);
  assert.strictEqual(address, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.strictEqual(res.status, 200);
  await closed(server);
});
