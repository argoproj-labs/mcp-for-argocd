import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PathValidationError } from './errors.js';
import { buildArgoCDUrl, encodePathSegment, normalizeBaseUrlPrefix } from './url.js';

test('encodePathSegment accepts valid Kubernetes and Argo CD resource names', () => {
  for (const name of ['guestbook', 'my-app_1', 'app.v2.0', 'A1-test']) {
    assert.equal(encodePathSegment(name, 'applicationName'), encodeURIComponent(name));
  }
});

test('encodePathSegment rejects path traversal, slashes, encoding tricks, and whitespace', () => {
  for (const bad of [
    '',
    '.',
    '..',
    '../clusters/in-cluster',
    'app/../projects/default',
    'app/sub',
    'app\\sub',
    '..%2fclusters',
    '%2e%2e',
    'app name',
    '-leading-dash',
    '.leading-dot',
    'a'.repeat(254)
  ]) {
    assert.throws(
      () => encodePathSegment(bad, 'applicationName'),
      (err) => err instanceof PathValidationError && err.fieldName === 'applicationName',
      `expected "${bad}" to be rejected`
    );
  }
});

test('buildArgoCDUrl preserves reverse-proxy subpaths in baseUrl', () => {
  const url = buildArgoCDUrl('https://devops.example.com/argocd', '/api/v1/applications');
  assert.equal(url.toString(), 'https://devops.example.com/argocd/api/v1/applications');

  const withSlash = buildArgoCDUrl('https://devops.example.com/argocd/', 'api/v1/projects');
  assert.equal(withSlash.toString(), 'https://devops.example.com/argocd/api/v1/projects');

  const root = buildArgoCDUrl('https://argocd.example.com', 'api/v1/clusters');
  assert.equal(root.toString(), 'https://argocd.example.com/api/v1/clusters');
});

test('buildArgoCDUrl rejects non-http protocols, embedded credentials, and traversal paths', () => {
  assert.throws(() => normalizeBaseUrlPrefix('file:///etc/passwd'), PathValidationError);
  assert.throws(
    () => normalizeBaseUrlPrefix('https://user:pass@argo.example.com'),
    PathValidationError
  );
  assert.throws(
    () => buildArgoCDUrl('https://argo.example.com/argocd', '../other'),
    PathValidationError
  );
});
