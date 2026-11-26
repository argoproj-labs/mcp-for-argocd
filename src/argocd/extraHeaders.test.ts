import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extraHeadersFromEnv, parseExtraHeaders } from './extraHeaders.js';

test('parseExtraHeaders returns empty object when unset or blank', () => {
  assert.deepEqual(parseExtraHeaders(undefined), {});
  assert.deepEqual(parseExtraHeaders(''), {});
  assert.deepEqual(parseExtraHeaders('   '), {});
});

test('parseExtraHeaders parses a JSON object of string headers', () => {
  assert.deepEqual(parseExtraHeaders('{"Cookie": "x-og-token=abc"}'), {
    Cookie: 'x-og-token=abc'
  });
});

test('parseExtraHeaders rejects invalid JSON', () => {
  assert.throws(() => parseExtraHeaders('{not json'), /valid JSON/);
});

test('parseExtraHeaders rejects non-object JSON', () => {
  assert.throws(() => parseExtraHeaders('[]'), /JSON object/);
  assert.throws(() => parseExtraHeaders('"cookie"'), /JSON object/);
});

test('parseExtraHeaders rejects non-string header values', () => {
  assert.throws(() => parseExtraHeaders('{"Cookie": 123}'), /must be a string/);
});

test('extraHeadersFromEnv reads from the provided env value', () => {
  assert.deepEqual(extraHeadersFromEnv('{"X-Custom": "value"}'), { 'X-Custom': 'value' });
});
