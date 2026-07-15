import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesDestCluster } from './client.js';

const identifiers = new Set(['prod', 'https://10.0.0.1:6443']);

test('matchesDestCluster matches by destination name', () => {
  assert.equal(matchesDestCluster({ name: 'prod' }, identifiers), true);
});

test('matchesDestCluster matches by destination server URL', () => {
  assert.equal(matchesDestCluster({ server: 'https://10.0.0.1:6443' }, identifiers), true);
});

test('matchesDestCluster matches a name-only destination against a set resolved from a URL', () => {
  // The caller resolved "https://10.0.0.1:6443" to the registered cluster and
  // expanded the set with its name; a name-only destination must match.
  assert.equal(matchesDestCluster({ name: 'prod' }, identifiers), true);
  assert.equal(matchesDestCluster({ server: 'https://10.0.0.1:6443' }, identifiers), true);
});

test('matchesDestCluster does not match a different cluster', () => {
  assert.equal(matchesDestCluster({ name: 'staging' }, identifiers), false);
  assert.equal(matchesDestCluster({ server: 'https://10.0.0.2:6443' }, identifiers), false);
});

test('matchesDestCluster does not match an undefined destination', () => {
  assert.equal(matchesDestCluster(undefined, identifiers), false);
});

test('matchesDestCluster is an exact match, not a substring match', () => {
  assert.equal(matchesDestCluster({ name: 'prod-eu' }, identifiers), false);
  assert.equal(matchesDestCluster({ server: '10.0.0.1' }, identifiers), false);
});
