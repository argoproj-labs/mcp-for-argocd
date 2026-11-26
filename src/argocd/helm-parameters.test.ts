import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertHelmParameters } from './helm-parameters.js';

test('upsert replaces deploy.imageTag and keeps other helm parameters', () => {
  const next = upsertHelmParameters(
    [
      { name: 'deploy.imageTag', value: 'v0.8.484-dev' },
      { name: 'binance.dual.gateway.api_key_id', value: '112', forceString: true },
      { name: 'config.binance.dual.gateway.ws_url', value: 'ws://qacb.sdtaop.com/sapi/wss' }
    ],
    [{ name: 'deploy.imageTag', value: 'v0.8.500-dev' }]
  );

  assert.deepEqual(next, [
    { name: 'deploy.imageTag', value: 'v0.8.500-dev' },
    { name: 'binance.dual.gateway.api_key_id', value: '112', forceString: true },
    { name: 'config.binance.dual.gateway.ws_url', value: 'ws://qacb.sdtaop.com/sapi/wss' }
  ]);
});

test('upsert appends a parameter that is not already set', () => {
  const next = upsertHelmParameters(
    [{ name: 'deploy.imageTag', value: 'v0.8.484-dev' }],
    [{ name: 'deploy.replicas', value: '2' }]
  );

  assert.deepEqual(next, [
    { name: 'deploy.imageTag', value: 'v0.8.484-dev' },
    { name: 'deploy.replicas', value: '2' }
  ]);
});

test('upsert rejects an empty value', () => {
  assert.throws(
    () => upsertHelmParameters([], [{ name: 'deploy.imageTag', value: '' }]),
    /value is empty/
  );
});
