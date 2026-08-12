import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelmOverridesSchema, KustomizeOverridesSchema, ParameterUnsetSchema } from './schema.js';

test('HelmOverridesSchema accepts parameters, fileParameters and valueFiles', () => {
  const parsed = HelmOverridesSchema.parse({
    parameters: [
      { name: 'image.tag', value: 'v2' },
      { name: 'debug', value: 'true', forceString: true }
    ],
    fileParameters: [{ name: 'cert', path: 'certs/tls.crt' }],
    valueFiles: ['values-prod.yaml']
  });
  assert.equal(parsed.parameters?.[0].name, 'image.tag');
  assert.equal(parsed.parameters?.[1].forceString, true);
  assert.equal(parsed.fileParameters?.[0].path, 'certs/tls.crt');
  assert.deepEqual(parsed.valueFiles, ['values-prod.yaml']);
});

test('HelmOverridesSchema rejects values and valuesObject together', () => {
  assert.throws(
    () => HelmOverridesSchema.parse({ values: 'a: 1', valuesObject: { a: 1 } }),
    /valuesObject/
  );
});

test('HelmOverridesSchema accepts either values or valuesObject alone', () => {
  assert.equal(HelmOverridesSchema.parse({ values: 'a: 1' }).values, 'a: 1');
  assert.deepEqual(HelmOverridesSchema.parse({ valuesObject: { a: 1 } }).valuesObject, { a: 1 });
});

test('KustomizeOverridesSchema accepts a numeric or string replica count', () => {
  const parsed = KustomizeOverridesSchema.parse({
    images: ['nginx:1.2'],
    replicas: [
      { name: 'web', count: 3 },
      { name: 'worker', count: '5' }
    ],
    namePrefix: 'dev-',
    commonLabels: { team: 'platform' }
  });
  assert.equal(parsed.replicas?.[0].count, 3);
  assert.equal(parsed.replicas?.[1].count, '5');
  assert.equal(parsed.commonLabels?.team, 'platform');
});

test('KustomizeOverridesSchema rejects a non-integer replica count', () => {
  assert.throws(
    () => KustomizeOverridesSchema.parse({ replicas: [{ name: 'web', count: 1.5 }] }),
    /Expected integer, received float/
  );
});

test('KustomizeOverridesSchema rejects a replica count string that is not an integer', () => {
  assert.throws(
    () => KustomizeOverridesSchema.parse({ replicas: [{ name: 'web', count: 'abc' }] }),
    /regex/
  );
});

test('KustomizeOverridesSchema rejects a negative replica count in either branch', () => {
  assert.throws(
    () => KustomizeOverridesSchema.parse({ replicas: [{ name: 'web', count: -1 }] }),
    /Number must be greater than or equal to 0/
  );
  assert.throws(
    () => KustomizeOverridesSchema.parse({ replicas: [{ name: 'web', count: '-1' }] }),
    /regex/
  );
});

test('ParameterUnsetSchema takes name arrays for keyed fields and booleans for scalars', () => {
  const parsed = ParameterUnsetSchema.parse({
    helm: { parameters: ['replicaCount'], values: true },
    kustomize: { images: ['nginx'], namePrefix: true, commonLabels: ['team'] }
  });
  assert.deepEqual(parsed.helm?.parameters, ['replicaCount']);
  assert.equal(parsed.helm?.values, true);
  assert.deepEqual(parsed.kustomize?.commonLabels, ['team']);
});

test('ParameterUnsetSchema rejects an array where a scalar field expects a boolean', () => {
  assert.throws(
    () => ParameterUnsetSchema.parse({ helm: { values: ['x'] } }),
    /Expected boolean, received array/
  );
  assert.throws(
    () => ParameterUnsetSchema.parse({ kustomize: { namePrefix: ['x'] } }),
    /Expected boolean, received array/
  );
});
