import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendUnique,
  applyHelmOverrides,
  applyKustomizeOverrides,
  applyParameterOverrides,
  buildPatchOps,
  detectDurability,
  kustomizeImageKey,
  mergeMap,
  removeFromList,
  removeKeyed,
  removeMapKeys,
  resolveTargetSource,
  setScalar,
  unsetScalar,
  upsertKeyed,
  type KustomizeReplica,
  type ParameterChange
} from './parameters.js';

test('resolveTargetSource returns spec.source when sourceIndex is omitted', () => {
  const source = { repoURL: 'https://git.example.com/a', path: 'chart' };
  assert.equal(resolveTargetSource({ source }), source);
});

test('resolveTargetSource returns the indexed source when sourceIndex is given', () => {
  const sources = [
    { repoURL: 'https://git.example.com/chart' },
    { repoURL: 'https://git.example.com/values' }
  ];
  assert.equal(resolveTargetSource({ sources }, 1), sources[1]);
});

// Catches: the two branches of resolveTargetSource reordered, so a spec carrying both
// forms resolves spec.source. This is a write-target invariant, not a preference: Argo CD
// renders a multi-source application from spec.sources and ignores spec.source, so the
// tool would build its ops against /spec/source, patch a field the application does not
// render from, see no error, and report applied: true for an override with no effect.
test('resolveTargetSource prefers sources over source when the spec has both', () => {
  const spec = {
    source: { repoURL: 'https://git.example.com/single' },
    sources: [
      { repoURL: 'https://git.example.com/chart' },
      { repoURL: 'https://git.example.com/values' }
    ]
  };

  assert.equal(resolveTargetSource(spec, 1), spec.sources[1]);
  // The multi-source rule still holds too: omitting sourceIndex is an error rather than a
  // silent fall back to spec.source, which would write to the ignored field.
  assert.throws(() => resolveTargetSource(spec), /sourceIndex is required/);
});

test('resolveTargetSource errors on a multi-source app when sourceIndex is omitted', () => {
  const sources = [
    { repoURL: 'https://git.example.com/chart' },
    { repoURL: 'https://git.example.com/values' },
    { path: 'local' }
  ];
  assert.throws(
    () => resolveTargetSource({ sources }),
    (err: Error) => {
      assert.match(err.message, /multi-source form \(spec\.sources\), so sourceIndex is required/);
      // The error must name each index with its repoURL so a retry is informed.
      assert.match(err.message, /0: https:\/\/git\.example\.com\/chart/);
      assert.match(err.message, /1: https:\/\/git\.example\.com\/values/);
      // A source may legally have no repoURL, and the listing still has to place it.
      assert.match(err.message, /2: \(no repoURL\)/);
      return true;
    }
  );
});

test('resolveTargetSource errors when sourceIndex is given for a single-source app', () => {
  assert.throws(
    () => resolveTargetSource({ source: { repoURL: 'https://git.example.com/a' } }, 0),
    {
      message:
        'This application has a single source, so sourceIndex does not apply. Omit sourceIndex.'
    }
  );
});

test('resolveTargetSource errors when sourceIndex is out of range', () => {
  const sources = [{ repoURL: 'https://git.example.com/chart' }];
  assert.throws(() => resolveTargetSource({ sources }, 3), /out of range.*0 to 0/i);
});

test('resolveTargetSource errors when sourceIndex is not an integer', () => {
  const sources = [
    { repoURL: 'https://git.example.com/chart' },
    { repoURL: 'https://git.example.com/values' }
  ];
  // A fractional index would otherwise index past the array and return undefined
  // from a function whose return type promises an AppSource.
  assert.throws(() => resolveTargetSource({ sources }, 1.5), /out of range/i);
});

test('resolveTargetSource errors when sourceIndex is NaN', () => {
  const sources = [
    { repoURL: 'https://git.example.com/chart' },
    { repoURL: 'https://git.example.com/values' }
  ];
  // NaN passes both range comparisons, so it needs the integer check to be caught.
  assert.throws(() => resolveTargetSource({ sources }, Number.NaN), /out of range/i);
});

test('resolveTargetSource errors when the spec has neither source nor sources', () => {
  assert.throws(() => resolveTargetSource({}), {
    message: 'This application has no source to apply parameter overrides to.'
  });
});

test('resolveTargetSource reports an empty sources array as having no source', () => {
  assert.throws(() => resolveTargetSource({ sources: [] }), {
    message: 'This application has no source to apply parameter overrides to.'
  });
});

test('resolveTargetSource reports an empty sources array as having no source, with an index', () => {
  // Guidance to omit sourceIndex would be a dead end here: omitting it cannot
  // produce a source, so the caller has to hear that there is none.
  assert.throws(() => resolveTargetSource({ sources: [] }, 0), {
    message: 'This application has no source to apply parameter overrides to.'
  });
});

const nameOf = (p: { name?: string }): string => p.name ?? '';

test('kustomizeImageKey picks the delimiter by priority, not by position', () => {
  assert.equal(kustomizeImageKey('nginx:1.2'), 'nginx');
  assert.equal(kustomizeImageKey('old=new:tag'), 'old');
  // ":" outranks "@", so a digest keys on the digest algorithm, not the bare repo.
  // Argo CD's own delim() does this; see the comment on kustomizeImageKey.
  assert.equal(kustomizeImageKey('nginx@sha256:abc'), 'nginx@sha256');
  assert.equal(kustomizeImageKey('myrepo/nginx:1.2'), 'myrepo/nginx');
  assert.equal(kustomizeImageKey('nginx'), 'nginx');
  // "=" wins over an earlier ":" — mirrors Argo CD, which picks the delimiter by
  // priority across the whole string, not the first delimiter character.
  assert.equal(kustomizeImageKey('localhost:5000/nginx=repo:1.0'), 'localhost:5000/nginx');
});

test('upserting a digest image alongside a tagged one keeps both entries', () => {
  // Pins the consequence of ":" outranking "@", not just the key: 'nginx:1.2' keys
  // on 'nginx' while 'nginx@sha256:abc' keys on 'nginx@sha256', so a retag to a
  // digest appends rather than replaces. Deliberate — this is what
  // `argocd app set --kustomize-image` produces, and our merge key has to agree
  // with Argo CD's KustomizeImage.Match(). If this test starts failing because
  // someone made "@" win, that is a design change to take upstream, not a fix.
  const changes: ParameterChange[] = [];
  const result = upsertKeyed(
    ['nginx:1.2'],
    ['nginx@sha256:abc'],
    kustomizeImageKey,
    'kustomize.images',
    changes
  );
  assert.deepEqual(result, ['nginx:1.2', 'nginx@sha256:abc']);
  assert.deepEqual(changes, [
    {
      field: 'kustomize.images',
      op: 'set',
      key: 'nginx@sha256',
      from: null,
      to: 'nginx@sha256:abc'
    }
  ]);
});

test('upsertKeyed adds new entries and replaces matching ones', () => {
  const changes: ParameterChange[] = [];
  const result = upsertKeyed(
    [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' }
    ],
    [
      { name: 'b', value: '9' },
      { name: 'c', value: '3' }
    ],
    nameOf,
    'helm.parameters',
    changes
  );
  assert.deepEqual(result, [
    { name: 'a', value: '1' },
    { name: 'b', value: '9' },
    { name: 'c', value: '3' }
  ]);
  assert.deepEqual(changes, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'b',
      from: { name: 'b', value: '2' },
      to: { name: 'b', value: '9' }
    },
    { field: 'helm.parameters', op: 'set', key: 'c', from: null, to: { name: 'c', value: '3' } }
  ]);
});

test('upsertKeyed records nothing when the entry is already identical', () => {
  const changes: ParameterChange[] = [];
  const result = upsertKeyed(
    [{ name: 'a', value: '1' }],
    [{ name: 'a', value: '1' }],
    nameOf,
    'helm.parameters',
    changes
  );
  assert.deepEqual(result, [{ name: 'a', value: '1' }]);
  assert.deepEqual(changes, []);
});

test('removeKeyed drops matching entries and ignores absent ones', () => {
  const changes: ParameterChange[] = [];
  const result = removeKeyed(
    [
      { name: 'a', value: '1' },
      { name: 'b', value: '2' }
    ],
    ['b', 'nope'],
    nameOf,
    'helm.parameters',
    changes
  );
  assert.deepEqual(result, [{ name: 'a', value: '1' }]);
  assert.deepEqual(changes, [
    { field: 'helm.parameters', op: 'unset', key: 'b', from: { name: 'b', value: '2' } }
  ]);
});

test('removeKeyed returns undefined when the list is emptied', () => {
  const changes: ParameterChange[] = [];
  assert.equal(removeKeyed([{ name: 'a' }], ['a'], nameOf, 'helm.parameters', changes), undefined);
  // Collapsing to undefined is still a change, and it has to be reported as one.
  assert.deepEqual(changes, [
    { field: 'helm.parameters', op: 'unset', key: 'a', from: { name: 'a' } }
  ]);
});

test('appendUnique appends absent entries at the end and skips duplicates', () => {
  const changes: ParameterChange[] = [];
  const result = appendUnique(
    ['base.yaml'],
    ['base.yaml', 'prod.yaml'],
    'helm.valueFiles',
    changes
  );
  assert.deepEqual(result, ['base.yaml', 'prod.yaml']);
  assert.deepEqual(changes, [
    { field: 'helm.valueFiles', op: 'set', key: 'prod.yaml', from: null, to: 'prod.yaml' }
  ]);
});

test('removeFromList removes by exact value and ignores absent values', () => {
  const changes: ParameterChange[] = [];
  const result = removeFromList(
    ['a.yaml', 'b.yaml'],
    ['b.yaml', 'zz.yaml'],
    'helm.valueFiles',
    changes
  );
  assert.deepEqual(result, ['a.yaml']);
  assert.deepEqual(changes, [
    { field: 'helm.valueFiles', op: 'unset', key: 'b.yaml', from: 'b.yaml' }
  ]);
});

test('setScalar replaces and records from/to, and no-ops on an equal value', () => {
  const changes: ParameterChange[] = [];
  assert.equal(setScalar(undefined, 'dev-', 'kustomize.namePrefix', changes), 'dev-');
  assert.deepEqual(changes, [{ field: 'kustomize.namePrefix', op: 'set', from: null, to: 'dev-' }]);

  const none: ParameterChange[] = [];
  assert.equal(setScalar('dev-', 'dev-', 'kustomize.namePrefix', none), 'dev-');
  assert.deepEqual(none, []);
});

test('setScalar leaves the current value alone when next is undefined', () => {
  const changes: ParameterChange[] = [];
  assert.equal(setScalar('dev-', undefined, 'kustomize.namePrefix', changes), 'dev-');
  assert.deepEqual(changes, []);
});

test('unsetScalar deletes only when remove is true and a value exists', () => {
  const changes: ParameterChange[] = [];
  assert.equal(unsetScalar('dev-', true, 'kustomize.namePrefix', changes), undefined);
  assert.deepEqual(changes, [{ field: 'kustomize.namePrefix', op: 'unset', from: 'dev-' }]);

  const none: ParameterChange[] = [];
  assert.equal(unsetScalar(undefined, true, 'kustomize.namePrefix', none), undefined);
  assert.deepEqual(none, []);
});

test('unsetScalar treats a null current value as nothing to unset', () => {
  // A spec can hold namePrefix: null, which is already absent as far as Argo CD is
  // concerned. Guarding on undefined alone would record { op: 'unset', from: null } and
  // report removing a prefix that was never set.
  const changes: ParameterChange[] = [];
  assert.equal(unsetScalar(null, true, 'kustomize.namePrefix', changes), null);
  assert.deepEqual(changes, []);
});

test('mergeMap merges by key and keeps unlisted keys', () => {
  const changes: ParameterChange[] = [];
  const result = mergeMap(
    { team: 'a', env: 'dev' },
    { team: 'b' },
    'kustomize.commonLabels',
    changes
  );
  assert.deepEqual(result, { team: 'b', env: 'dev' });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'set', key: 'team', from: 'a', to: 'b' }
  ]);
});

test('removeMapKeys removes listed keys and returns undefined when emptied', () => {
  const changes: ParameterChange[] = [];
  assert.deepEqual(removeMapKeys({ a: '1', b: '2' }, ['b'], 'kustomize.commonLabels', changes), {
    a: '1'
  });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'unset', key: 'b', from: '2' }
  ]);

  const emptied: ParameterChange[] = [];
  assert.equal(removeMapKeys({ a: '1' }, ['a'], 'kustomize.commonLabels', emptied), undefined);
  assert.deepEqual(emptied, [
    { field: 'kustomize.commonLabels', op: 'unset', key: 'a', from: '1' }
  ]);
});

// A helper that records no change must also return its input untouched. Otherwise a
// caller like `if (set.parameters) source.helm.parameters = upsertKeyed(...)` writes a
// new value into a spec that had none — `helm: { parameters: [] }` is truthy — while the
// change report says nothing happened. These use assert.equal, not deepEqual, so they
// pin identity: the very same object comes back out.

test('upsertKeyed returns the input untouched when nothing changed', () => {
  const changes: ParameterChange[] = [];
  assert.equal(upsertKeyed(undefined, [], nameOf, 'helm.parameters', changes), undefined);

  const list = [{ name: 'a', value: '1' }];
  assert.equal(
    upsertKeyed(list, [{ name: 'a', value: '1' }], nameOf, 'helm.parameters', changes),
    list
  );
  assert.deepEqual(changes, []);
});

test('appendUnique returns the input untouched when nothing changed', () => {
  const changes: ParameterChange[] = [];
  assert.equal(appendUnique(undefined, [], 'helm.valueFiles', changes), undefined);

  const list = ['base.yaml'];
  assert.equal(appendUnique(list, ['base.yaml'], 'helm.valueFiles', changes), list);
  assert.deepEqual(changes, []);
});

test('removeKeyed returns the input untouched when nothing was removed', () => {
  const changes: ParameterChange[] = [];
  // An empty list must survive as an empty list, not collapse to undefined: the
  // emptied-to-undefined rule is for lists this call actually emptied.
  const empty: { name?: string }[] = [];
  assert.equal(removeKeyed(empty, [], nameOf, 'helm.parameters', changes), empty);

  const list = [{ name: 'a' }];
  assert.equal(removeKeyed(list, ['nope'], nameOf, 'helm.parameters', changes), list);
  assert.equal(removeKeyed(undefined, ['a'], nameOf, 'helm.parameters', changes), undefined);
  assert.deepEqual(changes, []);
});

test('removeFromList returns the input untouched when nothing was removed', () => {
  const changes: ParameterChange[] = [];
  const empty: string[] = [];
  assert.equal(removeFromList(empty, [], 'helm.valueFiles', changes), empty);

  const list = ['a.yaml'];
  assert.equal(removeFromList(list, ['nope.yaml'], 'helm.valueFiles', changes), list);
  assert.equal(removeFromList(undefined, ['a.yaml'], 'helm.valueFiles', changes), undefined);
  assert.deepEqual(changes, []);
});

test('mergeMap returns the input untouched when nothing changed', () => {
  const changes: ParameterChange[] = [];
  assert.equal(mergeMap(undefined, {}, 'kustomize.commonLabels', changes), undefined);

  // Also the guard against re-recording an identical value: without it this helper
  // would report a change for every key the caller re-sends unmodified.
  const current = { team: 'a' };
  assert.equal(mergeMap(current, { team: 'a' }, 'kustomize.commonLabels', changes), current);
  assert.deepEqual(changes, []);
});

test('removeMapKeys returns the input untouched when nothing was removed', () => {
  const changes: ParameterChange[] = [];
  const empty: Record<string, string> = {};
  assert.equal(removeMapKeys(empty, [], 'kustomize.commonLabels', changes), empty);

  const current = { a: '1' };
  assert.equal(removeMapKeys(current, ['nope'], 'kustomize.commonLabels', changes), current);
  assert.equal(removeMapKeys(undefined, ['a'], 'kustomize.commonLabels', changes), undefined);
  assert.deepEqual(changes, []);
});

// Inherited Object.prototype names are reachable from the public surface, not a
// curiosity: toString, valueOf, constructor and hasOwnProperty are all syntactically
// valid Kubernetes label and annotation names, and unset.commonLabels is a user-supplied
// string[]. Reading the map with `in` or a bare index reaches the prototype.

test('removeMapKeys ignores keys the map only inherits from Object.prototype', () => {
  const changes: ParameterChange[] = [];
  const current = { a: '1' };
  // `'toString' in current` is true, so an `in` guard reports unsetting a label that was
  // never there and deletes nothing.
  assert.equal(removeMapKeys(current, ['toString'], 'kustomize.commonLabels', changes), current);
  assert.equal(
    removeMapKeys(
      current,
      ['valueOf', 'constructor', 'hasOwnProperty'],
      'kustomize.commonLabels',
      changes
    ),
    current
  );
  assert.deepEqual(changes, []);
});

test('removeMapKeys still removes an own key that shadows an Object.prototype name', () => {
  const changes: ParameterChange[] = [];
  assert.deepEqual(
    removeMapKeys({ toString: 'yes', a: '1' }, ['toString'], 'kustomize.commonLabels', changes),
    { a: '1' }
  );
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'unset', key: 'toString', from: 'yes' }
  ]);
});

test('mergeMap reports from: null for a key the map only inherits', () => {
  const changes: ParameterChange[] = [];
  // A bare `result[key]` read yields Object.prototype.toString here, and JSON.stringify
  // drops a function, so the change would serialize with `from` missing altogether —
  // silently breaking the documented ParameterChange contract.
  assert.deepEqual(mergeMap({ a: '1' }, { toString: 'yes' }, 'kustomize.commonLabels', changes), {
    a: '1',
    toString: 'yes'
  });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'set', key: 'toString', from: null, to: 'yes' }
  ]);
});

test('mergeMap no-ops on an own key that shadows an Object.prototype name', () => {
  const changes: ParameterChange[] = [];
  const current = { toString: 'yes' };
  assert.equal(mergeMap(current, { toString: 'yes' }, 'kustomize.commonLabels', changes), current);
  assert.deepEqual(changes, []);
});

test('the no-op check is relative to the changes already recorded by earlier calls', () => {
  // Helpers share one changes array across a whole merge, so "did I change anything"
  // cannot be `changes.length === 0` — by the time kustomize runs, helm has usually
  // appended entries already. A helper that got this wrong would pass every test above.
  const changes: ParameterChange[] = [];
  appendUnique(undefined, ['prod.yaml'], 'helm.valueFiles', changes);
  assert.equal(changes.length, 1);

  const list = ['nginx:1.2'];
  assert.equal(
    upsertKeyed(list, ['nginx:1.2'], kustomizeImageKey, 'kustomize.images', changes),
    list
  );
  const current = { team: 'a' };
  assert.equal(mergeMap(current, { team: 'a' }, 'kustomize.commonLabels', changes), current);
  assert.equal(changes.length, 1);
});

test('applyHelmOverrides upserts parameters and keeps unlisted ones', () => {
  const { helm, changes } = applyHelmOverrides(
    {
      parameters: [
        { name: 'replicaCount', value: '3' },
        { name: 'image.tag', value: 'v1' }
      ]
    },
    { parameters: [{ name: 'image.tag', value: 'v2' }] },
    undefined
  );
  assert.deepEqual(helm?.parameters, [
    { name: 'replicaCount', value: '3' },
    { name: 'image.tag', value: 'v2' }
  ]);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], {
    field: 'helm.parameters',
    op: 'set',
    key: 'image.tag',
    from: { name: 'image.tag', value: 'v1' },
    to: { name: 'image.tag', value: 'v2' }
  });
});

test('applyHelmOverrides applies unset before set, enabling a wholesale list replacement', () => {
  const { helm, changes } = applyHelmOverrides(
    { valueFiles: ['old-a.yaml', 'old-b.yaml'] },
    { valueFiles: ['new.yaml'] },
    { valueFiles: ['old-a.yaml', 'old-b.yaml'] }
  );
  assert.deepEqual(helm?.valueFiles, ['new.yaml']);
  // The resulting list alone does not witness the ordering here — appending then removing
  // lands on ['new.yaml'] too, because the unset and set sets are disjoint. The change
  // sequence is what differs, so assert on it.
  assert.deepEqual(changes, [
    { field: 'helm.valueFiles', op: 'unset', key: 'old-a.yaml', from: 'old-a.yaml' },
    { field: 'helm.valueFiles', op: 'unset', key: 'old-b.yaml', from: 'old-b.yaml' },
    { field: 'helm.valueFiles', op: 'set', key: 'new.yaml', from: null, to: 'new.yaml' }
  ]);
});

// Unset before set is the feature's contract, not an implementation detail: it is what lets
// one call replace a list wholesale, and on an auto-sync application every spec write is a
// deploy. The test above only witnesses it through the change sequence; this one witnesses it
// through the outcome, because unset and set name the same field. Swap the two branches and
// `values` ends up absent.
test('applyHelmOverrides applies unset before set on the same field', () => {
  const { helm, changes } = applyHelmOverrides(
    { values: 'a: 1' },
    { values: 'a: 2' },
    { values: true }
  );
  assert.equal(helm?.values, 'a: 2');
  assert.deepEqual(changes, [
    { field: 'helm.values', op: 'unset', from: 'a: 1' },
    { field: 'helm.values', op: 'set', from: null, to: 'a: 2' }
  ]);
});

test('applyHelmOverrides creates a block when the source has no helm section', () => {
  const { helm, changes } = applyHelmOverrides(
    undefined,
    { parameters: [{ name: 'image.tag', value: 'v2' }] },
    undefined
  );
  assert.deepEqual(helm?.parameters, [{ name: 'image.tag', value: 'v2' }]);
  assert.equal(changes[0].from, null);
});

test('applyHelmOverrides preserves fields it does not model', () => {
  const { helm } = applyHelmOverrides(
    { releaseName: 'my-release', version: '3', parameters: [{ name: 'a', value: '1' }] },
    { parameters: [{ name: 'a', value: '2' }] },
    undefined
  );
  assert.equal(helm?.releaseName, 'my-release');
  assert.equal(helm?.version, '3');
});

test('applyHelmOverrides handles values, valuesObject and fileParameters', () => {
  const { helm, changes } = applyHelmOverrides(
    { values: 'a: 1' },
    { values: 'a: 2', fileParameters: [{ name: 'cert', path: 'tls.crt' }] },
    undefined
  );
  assert.equal(helm?.values, 'a: 2');
  assert.deepEqual(helm?.fileParameters, [{ name: 'cert', path: 'tls.crt' }]);
  assert.equal(changes.length, 2);
  // `changes` is user-visible — it is the change summary the tool returns — so the field
  // labels are part of the contract and a typo or a swap between two fields must fail here.
  assert.deepEqual(changes, [
    {
      field: 'helm.fileParameters',
      op: 'set',
      key: 'cert',
      from: null,
      to: { name: 'cert', path: 'tls.crt' }
    },
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' }
  ]);
});

// valuesObject is the field most likely to be mislabelled, because it is the one whose label
// is a prefix-extension of another field's ('helm.values'). Both directions are pinned, and
// both assert that the sibling scalar was left alone.
test('applyHelmOverrides sets valuesObject under its own label', () => {
  const { helm, changes } = applyHelmOverrides(
    { values: 'a: 1' },
    { valuesObject: { image: { tag: 'v2' } } },
    undefined
  );
  assert.equal(helm?.values, 'a: 1');
  assert.deepEqual(helm?.valuesObject, { image: { tag: 'v2' } });
  assert.deepEqual(changes, [
    { field: 'helm.valuesObject', op: 'set', from: null, to: { image: { tag: 'v2' } } }
  ]);
});

test('applyHelmOverrides unsets valuesObject under its own label', () => {
  const { helm, changes } = applyHelmOverrides(
    { values: 'a: 1', valuesObject: { a: 1 } },
    undefined,
    {
      valuesObject: true
    }
  );
  assert.equal(helm?.values, 'a: 1');
  assert.deepEqual(Object.keys(helm ?? {}), ['values']);
  assert.deepEqual(changes, [{ field: 'helm.valuesObject', op: 'unset', from: { a: 1 } }]);
});

test('applyHelmOverrides unsets scalars and keyed entries', () => {
  const { helm, changes } = applyHelmOverrides(
    {
      values: 'a: 1',
      parameters: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ]
    },
    undefined,
    { values: true, parameters: ['a'] }
  );
  assert.equal(helm?.values, undefined);
  assert.deepEqual(helm?.parameters, [{ name: 'b', value: '2' }]);
  assert.equal(changes.length, 2);
});

// Catches: the entire `if (unset.fileParameters)` branch — replacing it with `if (false)`
// leaves the rest of the suite green, so nothing else here is evidence that removing a
// file parameter works. The deepEqual also pins the unset-direction labels for both keyed
// helm lists, which the assertion above measures only by count: a swap between
// 'helm.parameters' and 'helm.fileParameters' would remove the right entry and tell the
// caller it removed a different one.
test('applyHelmOverrides unsets file parameters and parameters under their own labels', () => {
  const { helm, changes } = applyHelmOverrides(
    {
      parameters: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ],
      fileParameters: [
        { name: 'cert', path: 'tls.crt' },
        { name: 'key', path: 'tls.key' }
      ]
    },
    undefined,
    { parameters: ['a'], fileParameters: ['cert'] }
  );

  assert.deepEqual(helm?.parameters, [{ name: 'b', value: '2' }]);
  assert.deepEqual(helm?.fileParameters, [{ name: 'key', path: 'tls.key' }]);
  assert.deepEqual(changes, [
    { field: 'helm.parameters', op: 'unset', key: 'a', from: { name: 'a', value: '1' } },
    {
      field: 'helm.fileParameters',
      op: 'unset',
      key: 'cert',
      from: { name: 'cert', path: 'tls.crt' }
    }
  ]);
});

test('applyHelmOverrides returns no changes when nothing is requested', () => {
  const { changes } = applyHelmOverrides(
    { parameters: [{ name: 'a', value: '1' }] },
    undefined,
    undefined
  );
  assert.deepEqual(changes, []);
});

test('applyHelmOverrides unsetting an absent parameter is a no-op', () => {
  const { helm, changes } = applyHelmOverrides(
    { parameters: [{ name: 'a', value: '1' }] },
    undefined,
    { parameters: ['not-there'] }
  );
  assert.deepEqual(helm?.parameters, [{ name: 'a', value: '1' }]);
  assert.deepEqual(changes, []);
});

test('applyHelmOverrides returns undefined when there was no block and nothing to set', () => {
  const { helm, changes } = applyHelmOverrides(undefined, undefined, { parameters: ['a'] });
  assert.equal(helm, undefined);
  assert.deepEqual(changes, []);
});

// Same guard, reached through the set branch instead of the unset one.
test('applyHelmOverrides returns undefined when an absent block gets an empty set', () => {
  const { helm, changes } = applyHelmOverrides(
    undefined,
    { parameters: [], valueFiles: [] },
    undefined
  );
  assert.equal(helm, undefined);
  assert.deepEqual(changes, []);
});

// The two tests below pin the property the helpers were widened to make possible: a merge
// that changes nothing must produce a block indistinguishable from the source one. Argo CD
// treats a present-but-empty override container differently from an absent one. An `undefined`
// own key is not harmless either: JSON.stringify does drop it, but it survives Object.keys and
// deepStrictEqual, so it defeats no-op detection and any key-walk over the merged block.

test('applyHelmOverrides does not materialize a container for an empty override list', () => {
  const { helm, changes } = applyHelmOverrides(
    { values: 'a: 1' },
    { parameters: [], fileParameters: [], valueFiles: [] },
    undefined
  );
  assert.deepEqual(Object.keys(helm ?? {}), ['values']);
  assert.deepEqual(changes, []);
});

test('applyHelmOverrides passes untouched fields through by reference on a no-op', () => {
  const parameters = [{ name: 'a', value: '1' }];
  const { helm, changes } = applyHelmOverrides({ values: 'a: 1', parameters }, undefined, {
    parameters: ['not-there'],
    values: false
  });
  assert.equal(helm?.parameters, parameters);
  assert.equal(helm?.values, 'a: 1');
  assert.deepEqual(Object.keys(helm ?? {}), ['values', 'parameters']);
  assert.deepEqual(changes, []);
});

// A replica count is IntOrString on the wire, so the same count arrives as 3 from a
// CLI-style override and as '3' from a YAML-authored spec. upsertKeyed's structural
// comparison calls those different, so it needs a way to be told otherwise — while still
// keying through keyOf and still writing the caller's value unnormalized.
test('upsertKeyed compares with the supplied comparator instead of structural equality', () => {
  const changes: ParameterChange[] = [];
  const sameCount = (a: KustomizeReplica, b: KustomizeReplica): boolean =>
    nameOf(a) === nameOf(b) && String(a.count) === String(b.count);

  const list: KustomizeReplica[] = [{ name: 'web', count: '3' }];
  assert.equal(
    upsertKeyed(
      list,
      [{ name: 'web', count: 3 }],
      nameOf,
      'kustomize.replicas',
      changes,
      sameCount
    ),
    list
  );
  assert.deepEqual(changes, []);

  // The comparator settles equality only. Keying still goes through keyOf, so an entry with
  // a new name is appended without ever being compared.
  assert.deepEqual(
    upsertKeyed(
      list,
      [{ name: 'worker', count: 1 }],
      nameOf,
      'kustomize.replicas',
      changes,
      sameCount
    ),
    [
      { name: 'web', count: '3' },
      { name: 'worker', count: 1 }
    ]
  );
  assert.deepEqual(changes, [
    {
      field: 'kustomize.replicas',
      op: 'set',
      key: 'worker',
      from: null,
      to: { name: 'worker', count: 1 }
    }
  ]);
});

test('applyKustomizeOverrides replaces an image by name across tag forms', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { images: ['nginx:1.2', 'redis:7'] },
    { images: ['nginx:1.3'] },
    undefined
  );
  assert.deepEqual(kustomize?.images, ['nginx:1.3', 'redis:7']);
  assert.deepEqual(changes, [
    { field: 'kustomize.images', op: 'set', key: 'nginx', from: 'nginx:1.2', to: 'nginx:1.3' }
  ]);
});

// 'nginx:1.2' keys on 'nginx' while 'nginx@sha256:abc' keys on 'nginx@sha256', because ':'
// outranks '@' in Argo CD's delim(). So retagging to a digest appends a second entry instead
// of replacing the first — deliberate, and what `argocd app set --kustomize-image` produces.
// See the comment on kustomizeImageKey; if this fails because someone made '@' win, that is
// a design change to take upstream, not a fix to land here.
test('applyKustomizeOverrides appends a digest override alongside the tagged image', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { images: ['nginx:1.2'] },
    { images: ['nginx@sha256:abc'] },
    undefined
  );
  assert.deepEqual(kustomize?.images, ['nginx:1.2', 'nginx@sha256:abc']);
  assert.deepEqual(changes, [
    {
      field: 'kustomize.images',
      op: 'set',
      key: 'nginx@sha256',
      from: null,
      to: 'nginx@sha256:abc'
    }
  ]);
});

test('applyKustomizeOverrides upserts replicas with numeric and string counts', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { replicas: [{ name: 'web', count: 2 }] },
    {
      replicas: [
        { name: 'web', count: 5 },
        { name: 'worker', count: '3' }
      ]
    },
    undefined
  );
  // deepEqual here is deepStrictEqual, so this also pins that neither count was coerced.
  assert.deepEqual(kustomize?.replicas, [
    { name: 'web', count: 5 },
    { name: 'worker', count: '3' }
  ]);
  assert.deepEqual(changes, [
    {
      field: 'kustomize.replicas',
      op: 'set',
      key: 'web',
      from: { name: 'web', count: 2 },
      to: { name: 'web', count: 5 }
    },
    {
      field: 'kustomize.replicas',
      op: 'set',
      key: 'worker',
      from: null,
      to: { name: 'worker', count: '3' }
    }
  ]);
});

// The IntOrString idempotency pair. Without the comparator, count: '3' in the spec against
// count: 3 from the caller records a change and rewrites the spec on every single call — and
// on an auto-sync application every write is a deploy, so it would present as the tool
// redeploying replicas forever.
test('applyKustomizeOverrides records no change when a replica count differs only in type', () => {
  const replicas: KustomizeReplica[] = [{ name: 'web', count: '3' }];
  const { kustomize, changes } = applyKustomizeOverrides(
    { replicas },
    { replicas: [{ name: 'web', count: 3 }] },
    undefined
  );
  assert.deepEqual(changes, []);
  // Reference identity, not just deep equality: recording nothing has to leave the block's
  // own array in place, or a later no-op check on the whole spec would still see a write.
  assert.equal(kustomize?.replicas, replicas);
  assert.deepEqual(kustomize?.replicas, [{ name: 'web', count: '3' }]);
});

test('applyKustomizeOverrides still records a replica count change across types', () => {
  // The counterpart to the test above: normalizing for the comparison must not make every
  // count compare equal. The value written is the caller's, unnormalized — 4, not '4'.
  const { kustomize, changes } = applyKustomizeOverrides(
    { replicas: [{ name: 'web', count: '3' }] },
    { replicas: [{ name: 'web', count: 4 }] },
    undefined
  );
  assert.deepEqual(kustomize?.replicas, [{ name: 'web', count: 4 }]);
  assert.deepEqual(changes, [
    {
      field: 'kustomize.replicas',
      op: 'set',
      key: 'web',
      from: { name: 'web', count: '3' },
      to: { name: 'web', count: 4 }
    }
  ]);
});

test('applyKustomizeOverrides merges commonLabels by key and keeps unlisted keys', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonLabels: { team: 'a', env: 'dev' } },
    { commonLabels: { team: 'b' } },
    undefined
  );
  assert.deepEqual(kustomize?.commonLabels, { team: 'b', env: 'dev' });
  // The label pins commonLabels against commonAnnotations: the two are structurally
  // identical, so a swapped call would pass any assertion made on the value alone.
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'set', key: 'team', from: 'a', to: 'b' }
  ]);
});

test('applyKustomizeOverrides sets and unsets namePrefix and nameSuffix', () => {
  const set = applyKustomizeOverrides({}, { namePrefix: 'dev-', nameSuffix: '-v2' }, undefined);
  assert.equal(set.kustomize?.namePrefix, 'dev-');
  assert.equal(set.kustomize?.nameSuffix, '-v2');
  assert.deepEqual(set.changes, [
    { field: 'kustomize.namePrefix', op: 'set', from: null, to: 'dev-' },
    { field: 'kustomize.nameSuffix', op: 'set', from: null, to: '-v2' }
  ]);

  // Both unset cases below clear exactly one of the two scalars while the block holds both, and
  // each asserts the sibling survived. Unsetting both at once would not distinguish the two
  // wirings: with both flags true, a nameSuffix wiring that reads unset.namePrefix still clears
  // the right field. Asymmetry is what makes a crossed flag, a dropped wiring and a swapped
  // label all fail.
  const clearedPrefix = applyKustomizeOverrides(
    { namePrefix: 'dev-', nameSuffix: '-v2' },
    undefined,
    {
      namePrefix: true
    }
  );
  // Object.keys, not just an undefined read: assigning undefined instead of deleting leaves
  // an own key that survives Object.keys and defeats no-op detection downstream.
  assert.deepEqual(Object.keys(clearedPrefix.kustomize ?? {}), ['nameSuffix']);
  assert.equal(clearedPrefix.kustomize?.nameSuffix, '-v2');
  assert.deepEqual(clearedPrefix.changes, [
    { field: 'kustomize.namePrefix', op: 'unset', from: 'dev-' }
  ]);

  const clearedSuffix = applyKustomizeOverrides(
    { namePrefix: 'dev-', nameSuffix: '-v2' },
    undefined,
    {
      nameSuffix: true
    }
  );
  assert.deepEqual(Object.keys(clearedSuffix.kustomize ?? {}), ['namePrefix']);
  assert.equal(clearedSuffix.kustomize?.namePrefix, 'dev-');
  assert.deepEqual(clearedSuffix.changes, [
    { field: 'kustomize.nameSuffix', op: 'unset', from: '-v2' }
  ]);
});

// Unset before set is the feature's contract, not an implementation detail: it is what lets
// one call replace a list wholesale, and on an auto-sync application every spec write is a
// deploy. Both tests below name the same field in unset and set, so swapping the two branches
// changes the outcome and not merely the order of `changes`.
test('applyKustomizeOverrides applies unset before set on the same field', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { namePrefix: 'a-' },
    { namePrefix: 'b-' },
    { namePrefix: true }
  );
  // Swap the branches and namePrefix ends up absent instead of 'b-'.
  assert.equal(kustomize?.namePrefix, 'b-');
  assert.deepEqual(changes, [
    { field: 'kustomize.namePrefix', op: 'unset', from: 'a-' },
    { field: 'kustomize.namePrefix', op: 'set', from: null, to: 'b-' }
  ]);
});

test('applyKustomizeOverrides replaces the images list wholesale in one call', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { images: ['nginx:1.2', 'redis:7'] },
    { images: ['nginx:1.3'] },
    { images: ['nginx', 'redis'] }
  );
  // Two properties at once. Swapped branches leave images absent, because the unset would
  // then remove the entry the set just wrote. And a set branch reading the original block
  // instead of the working copy would resurrect redis:7 and report from: 'nginx:1.2'.
  assert.deepEqual(kustomize?.images, ['nginx:1.3']);
  assert.deepEqual(changes, [
    { field: 'kustomize.images', op: 'unset', key: 'nginx', from: 'nginx:1.2' },
    { field: 'kustomize.images', op: 'unset', key: 'redis', from: 'redis:7' },
    { field: 'kustomize.images', op: 'set', key: 'nginx', from: null, to: 'nginx:1.3' }
  ]);
});

// The working-copy read is per-field, so covering it on a list does not cover it on a map. Under a
// set branch that reads the original block, mergeMap sees {a:'1',b:'2'} even though the unset just
// emptied the map, and b is resurrected into the deployed manifest — the same wrong-metadata-on-an
// -auto-sync-application consequence as writing annotations into commonLabels.
test('applyKustomizeOverrides replaces commonLabels wholesale in one call', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonLabels: { a: '1', b: '2' } },
    { commonLabels: { a: '9' } },
    { commonLabels: ['a', 'b'] }
  );
  assert.deepEqual(kustomize?.commonLabels, { a: '9' });
  // from: null on the set entry is the second witness: reading the original block would report
  // from: '1', because a would still be there to be overwritten.
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'unset', key: 'a', from: '1' },
    { field: 'kustomize.commonLabels', op: 'unset', key: 'b', from: '2' },
    { field: 'kustomize.commonLabels', op: 'set', key: 'a', from: null, to: '9' }
  ]);
});

// The twin of the test above. Verified necessary rather than assumed: with only the commonLabels
// one present, making set.commonAnnotations read the original block survived all 71 tests. Every
// working-copy read is its own mutation, so all four map and list cells need their own witness.
test('applyKustomizeOverrides replaces commonAnnotations wholesale in one call', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonAnnotations: { note: 'x', owner: 'me' } },
    { commonAnnotations: { note: 'z' } },
    { commonAnnotations: ['note', 'owner'] }
  );
  assert.deepEqual(kustomize?.commonAnnotations, { note: 'z' });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonAnnotations', op: 'unset', key: 'note', from: 'x' },
    { field: 'kustomize.commonAnnotations', op: 'unset', key: 'owner', from: 'me' },
    { field: 'kustomize.commonAnnotations', op: 'set', key: 'note', from: null, to: 'z' }
  ]);
});

// The same pair of properties on a keyed object list rather than a string list. Both branches of
// the replicas row read the working copy, so this is what fails if either one reaches back to the
// original block — a per-field mistake that the images test cannot catch.
test('applyKustomizeOverrides replaces the replicas list wholesale in one call', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    {
      replicas: [
        { name: 'web', count: 2 },
        { name: 'worker', count: 1 }
      ]
    },
    { replicas: [{ name: 'web', count: 5 }] },
    { replicas: ['web', 'worker'] }
  );
  // A set branch reading the original block resurrects worker and reports from: {web,2}.
  // Swapped branches leave replicas absent, because the unset removes what the set just wrote.
  assert.deepEqual(kustomize?.replicas, [{ name: 'web', count: 5 }]);
  assert.deepEqual(changes, [
    { field: 'kustomize.replicas', op: 'unset', key: 'web', from: { name: 'web', count: 2 } },
    { field: 'kustomize.replicas', op: 'unset', key: 'worker', from: { name: 'worker', count: 1 } },
    {
      field: 'kustomize.replicas',
      op: 'set',
      key: 'web',
      from: null,
      to: { name: 'web', count: 5 }
    }
  ]);
});

test('applyKustomizeOverrides removes images and replicas by name', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { images: ['nginx:1.2', 'redis:7'], replicas: [{ name: 'web', count: 2 }] },
    undefined,
    { images: ['nginx'], replicas: ['web'] }
  );
  assert.deepEqual(kustomize?.images, ['redis:7']);
  assert.deepEqual(Object.keys(kustomize ?? {}), ['images']);
  assert.deepEqual(changes, [
    { field: 'kustomize.images', op: 'unset', key: 'nginx', from: 'nginx:1.2' },
    { field: 'kustomize.replicas', op: 'unset', key: 'web', from: { name: 'web', count: 2 } }
  ]);
});

test('applyKustomizeOverrides removes commonAnnotations keys', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonAnnotations: { a: '1', b: '2' } },
    undefined,
    { commonAnnotations: ['b'] }
  );
  assert.deepEqual(kustomize?.commonAnnotations, { a: '1' });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonAnnotations', op: 'unset', key: 'b', from: '2' }
  ]);
});

// The four map wirings are visually near-identical, so each of the two rows needs both halves
// covered and each case has to carry the sibling map to catch a wiring that reads or writes the
// wrong one of the pair. commonLabels and commonAnnotations are the same type, so a swap is
// invisible to any assertion made on one map alone.
test('applyKustomizeOverrides removes commonLabels keys', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonLabels: { team: 'a', env: 'dev' }, commonAnnotations: { note: 'keep' } },
    undefined,
    { commonLabels: ['env'] }
  );
  assert.deepEqual(kustomize?.commonLabels, { team: 'a' });
  assert.deepEqual(kustomize?.commonAnnotations, { note: 'keep' });
  assert.deepEqual(changes, [
    { field: 'kustomize.commonLabels', op: 'unset', key: 'env', from: 'dev' }
  ]);
});

test('applyKustomizeOverrides merges commonAnnotations by key and keeps unlisted keys', () => {
  const commonLabels = { team: 'a' };
  const { kustomize, changes } = applyKustomizeOverrides(
    { commonLabels, commonAnnotations: { note: 'x', owner: 'me' } },
    { commonAnnotations: { note: 'y' } },
    undefined
  );
  assert.deepEqual(kustomize?.commonAnnotations, { note: 'y', owner: 'me' });
  // Reference identity on the labels map: the mutation this is here for merges the caller's
  // annotations into the manifest's labels instead, which on an auto-sync application deploys
  // wrong metadata. mergeMap would return a new object, so identity fails before the value does.
  assert.equal(kustomize?.commonLabels, commonLabels);
  assert.deepEqual(changes, [
    { field: 'kustomize.commonAnnotations', op: 'set', key: 'note', from: 'x', to: 'y' }
  ]);
});

test('applyKustomizeOverrides preserves fields it does not model', () => {
  const { kustomize } = applyKustomizeOverrides(
    { version: 'v5', forceCommonLabels: true, patches: [{ path: 'p.yaml' }], namePrefix: 'a-' },
    { namePrefix: 'b-' },
    undefined
  );
  assert.equal(kustomize?.version, 'v5');
  assert.equal(kustomize?.forceCommonLabels, true);
  assert.deepEqual(kustomize?.patches, [{ path: 'p.yaml' }]);
  assert.equal(kustomize?.namePrefix, 'b-');
});

test('applyKustomizeOverrides returns no changes when nothing is requested', () => {
  const block = { images: ['nginx:1.2'] };
  const { kustomize, changes } = applyKustomizeOverrides(block, undefined, undefined);
  assert.equal(kustomize, block);
  assert.deepEqual(changes, []);
});

test('applyKustomizeOverrides does not materialize a container for an empty override', () => {
  // Argo CD treats a present-but-empty override container differently from an absent one, so
  // `kustomize: { images: [] }` from a caller must not become a written-out empty list.
  const { kustomize, changes } = applyKustomizeOverrides(
    { version: 'v5' },
    { images: [], replicas: [], commonLabels: {}, commonAnnotations: {} },
    undefined
  );
  assert.deepEqual(Object.keys(kustomize ?? {}), ['version']);
  assert.deepEqual(changes, []);
});

test('applyKustomizeOverrides returns undefined when there was no block and nothing to set', () => {
  const { kustomize, changes } = applyKustomizeOverrides(
    undefined,
    { images: [] },
    {
      images: ['nginx'],
      namePrefix: true
    }
  );
  assert.equal(kustomize, undefined);
  assert.deepEqual(changes, []);
});

test('applyKustomizeOverrides passes untouched fields through by reference on a no-op', () => {
  const images = ['nginx:1.2'];
  const commonLabels = { team: 'a' };
  const { kustomize, changes } = applyKustomizeOverrides(
    { images, commonLabels },
    { images: ['nginx:1.2'], commonLabels: { team: 'a' } },
    { commonAnnotations: ['not-there'] }
  );
  assert.equal(kustomize?.images, images);
  assert.equal(kustomize?.commonLabels, commonLabels);
  assert.deepEqual(Object.keys(kustomize ?? {}), ['images', 'commonLabels']);
  assert.deepEqual(changes, []);
});

// The composition clones, so the returned source is never reference-identical to the input — the
// identity assertions the two halves rely on cannot be made here, and every no-op claim below is
// structural equality plus an exact key list instead.
test('applyParameterOverrides does not mutate the input source', () => {
  const original = {
    repoURL: 'https://git.example.com/a',
    helm: { parameters: [{ name: 'replicas', value: '1' }], values: 'old: true' },
    kustomize: { namePrefix: 'old-', commonLabels: { team: 'a' } }
  };
  const snapshot = JSON.parse(JSON.stringify(original));
  // Every override here writes a block back through `assign`, so without the clone the input's
  // own helm and kustomize keys are replaced in place: the caller loses the read-time values
  // that buildPatchOps needs for its `test` ops.
  applyParameterOverrides(original, {
    helm: { parameters: [{ name: 'replicas', value: '3' }] },
    kustomize: { commonLabels: { env: 'dev' } },
    unset: { helm: { values: true }, kustomize: { namePrefix: true } }
  });
  assert.deepEqual(original, snapshot);
});

test('applyParameterOverrides returns a source that shares no nested block with the input', () => {
  const original = {
    helm: { parameters: [{ name: 'replicas', value: '1' }] },
    kustomize: { namePrefix: 'old-' }
  };
  // Only kustomize is overridden, so the helm half early-returns the block it was handed. That
  // is the case a shallow `{ ...source }` survives while still aliasing the input's helm block
  // into the result — a later in-place edit downstream would then corrupt the read-time source.
  const { source } = applyParameterOverrides(original, { kustomize: { namePrefix: 'new-' } });
  assert.deepEqual(source.helm, original.helm);
  assert.notEqual(source, original);
  assert.notEqual(source.helm, original.helm);
  assert.notEqual(source.helm?.parameters, original.helm.parameters);
});

test('applyParameterOverrides hands each half the clone, not the input block', () => {
  const original = {
    helm: { parameters: [{ name: 'replicas', value: '1' }], valueFiles: ['values.yaml'] },
    kustomize: { namePrefix: 'old-', images: ['nginx:1.2'] }
  };
  // Both halves pass a field they were given nothing for through by reference, so valueFiles and
  // images below are whichever block the half was handed. A half called with `source.helm` or
  // `source.kustomize` rather than the clone's produces a structurally identical result that
  // shares these two arrays with the input — invisible to any value assertion.
  const { source } = applyParameterOverrides(original, {
    helm: { parameters: [{ name: 'replicas', value: '3' }] },
    kustomize: { namePrefix: 'new-' }
  });
  assert.deepEqual(source.helm?.valueFiles, ['values.yaml']);
  assert.deepEqual(source.kustomize?.images, ['nginx:1.2']);
  assert.notEqual(source.helm?.valueFiles, original.helm.valueFiles);
  assert.notEqual(source.kustomize?.images, original.kustomize.images);
});

// Both halves get a set and an unset, so a dropped `overrides.unset?.helm` or
// `overrides.unset?.kustomize` argument loses an entry, and the full-array assertion pins the
// order: helm's changes come before kustomize's, which is what fails if the two pushes are
// swapped or either half runs first.
test('applyParameterOverrides applies both halves and concatenates helm changes first', () => {
  const { source, changes } = applyParameterOverrides(
    {
      repoURL: 'https://git.example.com/a',
      helm: { parameters: [{ name: 'replicas', value: '1' }], values: 'old: true' },
      kustomize: { namePrefix: 'old-', commonLabels: { team: 'a' } }
    },
    {
      helm: { parameters: [{ name: 'replicas', value: '3' }] },
      kustomize: { commonLabels: { env: 'dev' } },
      unset: { helm: { values: true }, kustomize: { namePrefix: true } }
    }
  );
  assert.deepEqual(source, {
    repoURL: 'https://git.example.com/a',
    helm: { parameters: [{ name: 'replicas', value: '3' }] },
    kustomize: { commonLabels: { team: 'a', env: 'dev' } }
  });
  assert.deepEqual(changes, [
    { field: 'helm.values', op: 'unset', from: 'old: true' },
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'replicas',
      from: { name: 'replicas', value: '1' },
      to: { name: 'replicas', value: '3' }
    },
    { field: 'kustomize.namePrefix', op: 'unset', from: 'old-' },
    { field: 'kustomize.commonLabels', op: 'set', key: 'env', from: null, to: 'dev' }
  ]);
});

test('applyParameterOverrides returns an unchanged source and no changes for a no-op', () => {
  const original = {
    repoURL: 'https://git.example.com/a',
    helm: { releaseName: 'app', parameters: [{ name: 'a', value: '1' }] }
  };
  const { source, changes } = applyParameterOverrides(original, {
    helm: { parameters: [{ name: 'a', value: '1' }] },
    unset: { helm: { parameters: ['absent'] }, kustomize: { namePrefix: true } }
  });
  assert.deepEqual(source, original);
  // The kustomize half reports undefined for an app that has no kustomize block, so writing the
  // result with `next.kustomize = ...` instead of deleting leaves an own key holding undefined —
  // which JSON.stringify hides but the Argo CD API would see as a present container.
  assert.deepEqual(Object.keys(source), ['repoURL', 'helm']);
  assert.deepEqual(Object.keys(source.helm ?? {}), ['releaseName', 'parameters']);
  assert.deepEqual(changes, []);
});

test('applyParameterOverrides does not materialize a block for empty override containers', () => {
  // Argo CD treats a present-but-empty override container differently from an absent one, so
  // neither an empty helm nor an empty kustomize override may add a section to the source.
  const { source, changes } = applyParameterOverrides(
    { repoURL: 'https://git.example.com/a' },
    { helm: { parameters: [], valueFiles: [] }, kustomize: { images: [], replicas: [] } }
  );
  assert.deepEqual(Object.keys(source), ['repoURL']);
  assert.deepEqual(changes, []);
});

test('applyParameterOverrides preserves source fields it does not model', () => {
  // Rebuilding the source from the fields this feature knows about — rather than cloning and
  // merging into the clone — silently drops path, targetRevision, chart and ref, which for a
  // multi-source app is the difference between a values ref and a broken app.
  const { source, changes } = applyParameterOverrides(
    {
      repoURL: 'https://git.example.com/a',
      path: 'charts/app',
      targetRevision: 'v1.2.3',
      chart: 'app',
      ref: 'values',
      helm: { releaseName: 'app', version: 'v3', parameters: [{ name: 'a', value: '1' }] },
      kustomize: { version: 'v5', patches: [{ path: 'p.yaml' }], namePrefix: 'old-' }
    },
    {
      helm: { parameters: [{ name: 'a', value: '2' }] },
      kustomize: { namePrefix: 'new-' }
    }
  );
  assert.deepEqual(source, {
    repoURL: 'https://git.example.com/a',
    path: 'charts/app',
    targetRevision: 'v1.2.3',
    chart: 'app',
    ref: 'values',
    helm: { releaseName: 'app', version: 'v3', parameters: [{ name: 'a', value: '2' }] },
    kustomize: { version: 'v5', patches: [{ path: 'p.yaml' }], namePrefix: 'new-' }
  });
  assert.deepEqual(changes, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'a',
      from: { name: 'a', value: '1' },
      to: { name: 'a', value: '2' }
    },
    { field: 'kustomize.namePrefix', op: 'set', from: 'old-', to: 'new-' }
  ]);
});

test('applyParameterOverrides leaves both blocks in place when no overrides are given', () => {
  const original = {
    repoURL: 'https://git.example.com/a',
    helm: { parameters: [{ name: 'a', value: '1' }] },
    kustomize: { images: ['nginx:1.2'] }
  };
  // Writing a block back only when its half reported a change is a plausible "touch nothing we
  // did not modify" shortcut, and it would drop both of these blocks from the spec.
  const { source, changes } = applyParameterOverrides(original, {});
  assert.deepEqual(source, original);
  assert.deepEqual(Object.keys(source), ['repoURL', 'helm', 'kustomize']);
  assert.deepEqual(changes, []);
});

test('buildPatchOps emits one add for the whole block when the block was absent', () => {
  // Per-field ops cannot create the block: RFC 6902 `add` does not create intermediate
  // paths, so `add /spec/source/helm/parameters` fails outright when there is no helm.
  const before = { repoURL: 'r' };
  const after = { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }] } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.parameters', op: 'set', key: 'a', from: null, to: { name: 'a', value: '1' } }
  ]);
  assert.deepEqual(ops, [
    { op: 'add', path: '/spec/source/helm', value: { parameters: [{ name: 'a', value: '1' }] } }
  ]);
});

test('buildPatchOps emits per-field ops with a test guard when the block existed', () => {
  // Two mutations die here: replacing the whole block (which would carry releaseName's
  // read-time value and revert a concurrent edit to it), and dropping the `test` op or
  // giving it the after-value instead of the read-time one.
  const before = { helm: { parameters: [{ name: 'a', value: '1' }], releaseName: 'keep-me' } };
  const after = { helm: { parameters: [{ name: 'a', value: '2' }], releaseName: 'keep-me' } };
  const ops = buildPatchOps(undefined, before, after, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'a',
      from: { name: 'a', value: '1' },
      to: { name: 'a', value: '2' }
    }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    { op: 'add', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '2' }] }
  ]);
  // releaseName is never sent, so a concurrent edit to it survives.
  assert.equal(
    ops.some((o) => JSON.stringify(o).includes('releaseName')),
    false
  );
});

test('buildPatchOps omits the test op for a field that did not exist at read time', () => {
  // An unconditional `test` op would fail on every first write of a field, because
  // RFC 6902 `test` fails on a path that is not there rather than matching undefined.
  const before = { helm: { releaseName: 'r' } };
  const after = { helm: { releaseName: 'r', values: 'a: 1' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.values', op: 'set', from: null, to: 'a: 1' }
  ]);
  assert.deepEqual(ops, [{ op: 'add', path: '/spec/source/helm/values', value: 'a: 1' }]);
});

test('buildPatchOps emits remove when a field is emptied', () => {
  // `assign` deletes the key rather than assigning undefined, so an emptied field
  // reaches us as an absent key. Reading that as "no new value" and emitting an `add`
  // would write `null`, which Argo CD keeps as a present field.
  const before = { helm: { parameters: [{ name: 'a', value: '1' }], releaseName: 'r' } };
  const after = { helm: { releaseName: 'r' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.parameters', op: 'unset', key: 'a', from: { name: 'a', value: '1' } }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    { op: 'remove', path: '/spec/source/helm/parameters' }
  ]);
});

test('buildPatchOps reads an emptied array and an emptied object as removals too', () => {
  // The other two shapes an emptied field can arrive in. Dropping either clause of
  // isEmptyValue turns the op into `add` with an empty container, which Argo CD treats
  // as a live override rather than an absent one.
  const emptiedArray = buildPatchOps(
    undefined,
    { helm: { valueFiles: ['v.yaml'] } },
    { helm: { valueFiles: [] } },
    [{ field: 'helm.valueFiles', op: 'unset', key: 'v.yaml', from: 'v.yaml' }]
  );
  assert.deepEqual(emptiedArray, [
    { op: 'test', path: '/spec/source/helm/valueFiles', value: ['v.yaml'] },
    { op: 'remove', path: '/spec/source/helm/valueFiles' }
  ]);

  const emptiedObject = buildPatchOps(
    undefined,
    { kustomize: { commonLabels: { team: 'a' } } },
    { kustomize: { commonLabels: {} } },
    [{ field: 'kustomize.commonLabels', op: 'unset', key: 'team', from: 'a' }]
  );
  assert.deepEqual(emptiedObject, [
    { op: 'test', path: '/spec/source/kustomize/commonLabels', value: { team: 'a' } },
    { op: 'remove', path: '/spec/source/kustomize/commonLabels' }
  ]);
});

test('buildPatchOps writes an empty string rather than removing the field', () => {
  // A falsiness test (`!value`) instead of isEmptyValue reads '' as empty and would
  // silently turn "set values to the empty string" into a removal.
  const ops = buildPatchOps(undefined, { helm: { values: 'a: 1' } }, { helm: { values: '' } }, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: '' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/source/helm/values', value: '' }
  ]);
});

test('buildPatchOps emits nothing for a field that was absent and is still empty', () => {
  // `set: { helm: { valuesObject: {} } }` on a helm block that has no valuesObject:
  // setScalar records a change because JSON.stringify(undefined) is not '{}', so the
  // field arrives empty and unseen at read time. Emitting `remove` here would fail the
  // whole patch, since RFC 6902 `remove` requires the target location to exist.
  const ops = buildPatchOps(
    undefined,
    { helm: { releaseName: 'r' } },
    { helm: { releaseName: 'r', valuesObject: {} } },
    [{ field: 'helm.valuesObject', op: 'set', from: null, to: {} }]
  );
  assert.deepEqual(ops, []);
});

test('buildPatchOps targets /spec/sources/{i} when sourceIndex is given', () => {
  const before = { helm: { values: 'a: 1' } };
  const after = { helm: { values: 'a: 2' } };
  const ops = buildPatchOps(1, before, after, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/sources/1/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/sources/1/helm/values', value: 'a: 2' }
  ]);
});

test('buildPatchOps targets /spec/sources/0 for the first source of a multi-source app', () => {
  // A truthiness check on sourceIndex (`sourceIndex ? ... : '/spec/source'`) passes the
  // index-1 test above and then writes source 0's overrides to the single-source path,
  // which for a multi-source application is a different field entirely.
  const ops = buildPatchOps(0, { helm: { values: 'a: 1' } }, { helm: { values: 'a: 2' } }, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/sources/0/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/sources/0/helm/values', value: 'a: 2' }
  ]);
});

test('buildPatchOps never emits a test op against /metadata/resourceVersion', () => {
  // Regression guard. A resourceVersion CAS reads as equivalent but is unusable:
  // the application controller writes status constantly, so every status write
  // bumps resourceVersion and the patch would fail on unrelated activity.
  const before = { helm: { values: 'a: 1' } };
  const after = { helm: { values: 'a: 2' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' }
  ]);
  assert.equal(
    ops.some((o) => o.path.includes('resourceVersion')),
    false
  );
  // Nothing outside the spec is addressed at all, so no metadata field can creep in.
  assert.equal(
    ops.every((o) => o.path.startsWith('/spec/')),
    true
  );
});

test('buildPatchOps groups both blocks into one patch document', () => {
  const before = { helm: { values: 'a: 1' }, kustomize: { namePrefix: 'x-' } };
  const after = { helm: { values: 'a: 2' }, kustomize: { namePrefix: 'y-' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' },
    { field: 'kustomize.namePrefix', op: 'set', from: 'x-', to: 'y-' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/source/helm/values', value: 'a: 2' },
    { op: 'test', path: '/spec/source/kustomize/namePrefix', value: 'x-' },
    { op: 'add', path: '/spec/source/kustomize/namePrefix', value: 'y-' }
  ]);
});

test('buildPatchOps keeps the blocks apart when only helm existed at read time', () => {
  // HelmBlock and KustomizeBlock are mutually assignable through their index
  // signatures, so reading one block's before/after under the other block's name is
  // invisible to tsc. Here the two blocks take different branches — helm per-field,
  // kustomize whole-block — so any such swap changes the document.
  const before = { helm: { values: 'a: 1' } };
  const after = { helm: { values: 'a: 2' }, kustomize: { namePrefix: 'y-' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' },
    { field: 'kustomize.namePrefix', op: 'set', from: null, to: 'y-' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/source/helm/values', value: 'a: 2' },
    { op: 'add', path: '/spec/source/kustomize', value: { namePrefix: 'y-' } }
  ]);
});

test('buildPatchOps keeps the blocks apart when only kustomize existed at read time', () => {
  // The mirror of the case above: the same swap has to fail in both orientations,
  // and this one also pins the order the blocks are emitted in.
  const before = { kustomize: { namePrefix: 'x-' } };
  const after = { helm: { values: 'v' }, kustomize: { namePrefix: 'y-' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'kustomize.namePrefix', op: 'set', from: 'x-', to: 'y-' },
    { field: 'helm.values', op: 'set', from: null, to: 'v' }
  ]);
  assert.deepEqual(ops, [
    { op: 'add', path: '/spec/source/helm', value: { values: 'v' } },
    { op: 'test', path: '/spec/source/kustomize/namePrefix', value: 'x-' },
    { op: 'add', path: '/spec/source/kustomize/namePrefix', value: 'y-' }
  ]);
});

test('buildPatchOps collapses several changes to one field into a single op pair', () => {
  // Without deduplication each change gets its own test/add pair, and the second
  // `test` compares the read-time value against the value the first `add` just wrote:
  // it fails, and Argo CD rejects the whole patch. Two ops per changed field, always.
  const before = { helm: { parameters: [{ name: 'a', value: '1' }] } };
  const after = {
    helm: {
      parameters: [
        { name: 'a', value: '2' },
        { name: 'b', value: '9' }
      ]
    }
  };
  const ops = buildPatchOps(undefined, before, after, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'a',
      from: { name: 'a', value: '1' },
      to: { name: 'a', value: '2' }
    },
    { field: 'helm.parameters', op: 'set', key: 'b', from: null, to: { name: 'b', value: '9' } }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    {
      op: 'add',
      path: '/spec/source/helm/parameters',
      value: [
        { name: 'a', value: '2' },
        { name: 'b', value: '9' }
      ]
    }
  ]);
});

test('buildPatchOps sends only the fields that changed, not every field it models', () => {
  // Sibling fields inside the same block are as clobberable as unmodelled ones: a
  // loop over the known field names instead of over `changes` would rewrite values
  // and valueFiles with their read-time values on a call that only set parameters.
  const before = {
    helm: { parameters: [{ name: 'a', value: '1' }], values: 'a: 1', valueFiles: ['v.yaml'] }
  };
  const after = {
    helm: { parameters: [{ name: 'a', value: '2' }], values: 'a: 1', valueFiles: ['v.yaml'] }
  };
  const ops = buildPatchOps(undefined, before, after, [
    {
      field: 'helm.parameters',
      op: 'set',
      key: 'a',
      from: { name: 'a', value: '1' },
      to: { name: 'a', value: '2' }
    }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    { op: 'add', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '2' }] }
  ]);
});

test('buildPatchOps consumes applyParameterOverrides output for a real merge', () => {
  // End to end over the module: the shapes buildPatchOps has to read are whatever the
  // merge produces, so this pins the two together. Removing helm's only parameter
  // deletes the key, and kustomize gains a block it did not have.
  const original = {
    repoURL: 'https://git.example.com/a',
    helm: { releaseName: 'app', parameters: [{ name: 'a', value: '1' }] }
  };
  const { source, changes } = applyParameterOverrides(original, {
    kustomize: { namePrefix: 'new-' },
    unset: { helm: { parameters: ['a'] } }
  });
  assert.deepEqual(buildPatchOps(undefined, original, source, changes), [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    { op: 'remove', path: '/spec/source/helm/parameters' },
    { op: 'add', path: '/spec/source/kustomize', value: { namePrefix: 'new-' } }
  ]);
});

test('buildPatchOps returns an empty list when there are no changes', () => {
  assert.deepEqual(buildPatchOps(undefined, { helm: {} }, { helm: {} }, []), []);
});

test('buildPatchOps does not resolve a field name through Object.prototype', () => {
  // The merge helpers only ever record the field names hardcoded in this module, so no
  // reachable call names a prototype member today. The own-property check is what keeps
  // that from mattering: `field in blockBefore` would report a `constructor` field as
  // present at read time and emit a test op whose value is a function — dropped by
  // JSON.stringify, leaving a malformed op that fails the whole patch.
  const ops = buildPatchOps(
    undefined,
    { helm: { releaseName: 'r' } },
    { helm: { releaseName: 'r', constructor: 'x' } },
    [{ field: 'helm.constructor', op: 'set', from: null, to: 'x' }]
  );
  assert.deepEqual(ops, [{ op: 'add', path: '/spec/source/helm/constructor', value: 'x' }]);
});

test('buildPatchOps emits a pair per field when one block has two changed fields', () => {
  // The commonest shape of a real call, and the one that pins the loop over touchedFields:
  // slicing it to the first or the last field survives every other test here, because they
  // all put their two fields in different blocks or two changes on the same field. That bug
  // is a silent partial write — the change list the tool reports comes from the merge layer,
  // so the response would claim both fields changed while the patch carried one.
  // Mixed on purpose: one field emptied, one set.
  const before = {
    helm: { parameters: [{ name: 'a', value: '1' }], values: 'a: 1', releaseName: 'r' }
  };
  const after = { helm: { values: 'a: 2', releaseName: 'r' } };
  const ops = buildPatchOps(undefined, before, after, [
    { field: 'helm.parameters', op: 'unset', key: 'a', from: { name: 'a', value: '1' } },
    { field: 'helm.values', op: 'set', from: 'a: 1', to: 'a: 2' }
  ]);
  assert.deepEqual(ops, [
    { op: 'test', path: '/spec/source/helm/parameters', value: [{ name: 'a', value: '1' }] },
    { op: 'remove', path: '/spec/source/helm/parameters' },
    { op: 'test', path: '/spec/source/helm/values', value: 'a: 1' },
    { op: 'add', path: '/spec/source/helm/values', value: 'a: 2' }
  ]);
});

test('buildPatchOps targets /spec/sources/{i} for a block absent at read time too', () => {
  // The other two sourceIndex tests start from a helm block that already exists, so they
  // only pin basePath through the per-field branch. Hardcoding /spec/source in the
  // whole-block branch passes both of them and then emits `add /spec/source/helm` on a
  // multi-source application, where spec.source does not exist — RFC 6902 `add` cannot
  // create the intermediate path, so Argo CD rejects the patch. That breaks every
  // multi-source app on its first use of this feature.
  const ops = buildPatchOps(1, { repoURL: 'r' }, { repoURL: 'r', helm: { values: 'a: 1' } }, [
    { field: 'helm.values', op: 'set', from: null, to: 'a: 1' }
  ]);
  assert.deepEqual(ops, [{ op: 'add', path: '/spec/sources/1/helm', value: { values: 'a: 1' } }]);
});

test('buildPatchOps does not add a block that would hold nothing but empty containers', () => {
  // The absent-block counterpart of `emits nothing for a field that was absent and is still
  // empty`: the same input must not turn into a spec write just because the block is missing
  // too. Built through the merge so the reachability is not assumed — setScalar records a
  // change for valuesObject: {} because JSON.stringify(undefined) is not '{}'.
  const original = { repoURL: 'https://git.example.com/a' };
  const { source, changes } = applyParameterOverrides(original, { helm: { valuesObject: {} } });
  assert.deepEqual(changes, [{ field: 'helm.valuesObject', op: 'set', from: null, to: {} }]);
  assert.deepEqual(buildPatchOps(undefined, original, source, changes), []);
});

test('buildPatchOps adds an absent block carrying only its non-empty fields', () => {
  // The mixed half: dropping the whole block because one of its fields is empty would lose
  // the real override, and sending the block unfiltered would write `valuesObject: {}`, which
  // Argo CD reads as a live override rather than an absent one.
  const ops = buildPatchOps(
    undefined,
    { repoURL: 'r' },
    { repoURL: 'r', helm: { parameters: [{ name: 'a', value: '1' }], valuesObject: {} } },
    [
      { field: 'helm.parameters', op: 'set', key: 'a', from: null, to: { name: 'a', value: '1' } },
      { field: 'helm.valuesObject', op: 'set', from: null, to: {} }
    ]
  );
  assert.deepEqual(ops, [
    {
      op: 'add',
      path: '/spec/source/helm',
      value: { parameters: [{ name: 'a', value: '1' }] }
    }
  ]);
});

test('buildPatchOps adds an absent block whose only field is the empty string', () => {
  // The absent-block counterpart of `writes an empty string rather than removing the field`.
  // That test pins the predicate and the per-field branch, but a falsiness check added at
  // this branch's call site (`fieldValue &&`, or `fieldValue !== ''`) passes it. Reachable:
  // helm.values is z.string().optional() with no .min(1), so `set: {helm: {values: ''}}`
  // validates and the merge records it. Under that mutation the filter strips the field, the
  // nothing-remains guard suppresses the op, and Task 11 skips the PATCH and reports
  // not-applied — a legitimate override silently never written.
  const ops = buildPatchOps(undefined, { repoURL: 'r' }, { repoURL: 'r', helm: { values: '' } }, [
    { field: 'helm.values', op: 'set', from: null, to: '' }
  ]);
  assert.deepEqual(ops, [{ op: 'add', path: '/spec/source/helm', value: { values: '' } }]);
});

test('detectDurability flags an ApplicationSet owner reference', () => {
  // The failure this function exists to prevent: the override is reverted on the next
  // ApplicationSet reconcile with no error raised anywhere, so a durable: true here would have
  // the tool report success for a change that disappears minutes later. Also pins the reason,
  // because ignoreApplicationDifferences is the only thing that preserves this path —
  // preservedFields covers annotations and labels and never spec.source.
  const result = detectDurability({
    metadata: { name: 'my-app', ownerReferences: [{ kind: 'ApplicationSet', name: 'prod-apps' }] }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'ApplicationSet', name: 'prod-apps' });
  assert.match(result.note ?? '', /generated by an ApplicationSet/);
  assert.match(result.note ?? '', /ignoreApplicationDifferences/);
  // Keyword presence alone does not pin what the note claims. Without these two, a note that
  // says the override "will be preserved" — reassurance contradicting durable: false — or one
  // that recommends preservedFields, the one mechanism that provably cannot hold spec.source,
  // still passes. The note is what a model relays verbatim, so its claim is part of the
  // contract, while the surrounding prose stays free to be reworded.
  assert.match(result.note ?? '', /will be reverted/);
  assert.doesNotMatch(result.note ?? '', /preservedFields/);
  // The app-of-apps reason would send the caller somewhere useless: an ApplicationSet reverts
  // the spec whether or not any application has selfHeal enabled.
  assert.doesNotMatch(result.note ?? '', /selfHeal/);
});

test('detectDurability finds the ApplicationSet owner among other owner references', () => {
  // Reading ownerReferences[0] instead of searching the list passes the test above, and Argo CD
  // does not promise the generated Application carries exactly one owner reference.
  const result = detectDurability({
    metadata: {
      name: 'my-app',
      ownerReferences: [
        { kind: 'ConfigMap', name: 'unrelated' },
        { kind: 'ApplicationSet', name: 'prod-apps' }
      ]
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'ApplicationSet', name: 'prod-apps' });
});

test('detectDurability ignores an owner reference that is not an ApplicationSet', () => {
  // Catches the kind comparison loosened to any owner reference, or to a substring — this
  // reference's kind satisfies `kind.includes('Application')`. Only the ApplicationSet
  // controller reconciles a generated spec back to a template, so nothing else warrants a
  // warning, and warning anyway would train the caller to ignore the field.
  assert.deepEqual(
    detectDurability({
      metadata: { name: 'my-app', ownerReferences: [{ kind: 'Application', name: 'root-app' }] }
    }),
    { durable: true }
  );
});

test('detectDurability flags a tracking label naming a different application', () => {
  // Catches the label source dropped, or read out of the annotation map, and the app-of-apps
  // branch removed. The note has to name the parent: the caller cannot act on "some parent
  // reverts this" without knowing which application to change.
  const result = detectDurability({
    metadata: { name: 'child-app', labels: { 'app.kubernetes.io/instance': 'root-app' } }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'root-app' });
  assert.match(result.note ?? '', /"root-app"/);
  assert.match(result.note ?? '', /selfHeal/);
  // Same reason as the ApplicationSet note: a warning that inverts into "will be preserved"
  // keeps every keyword this test would otherwise check.
  assert.match(result.note ?? '', /will be reverted/);
  assert.doesNotMatch(result.note ?? '', /ignoreApplicationDifferences/);
});

test('detectDurability flags a tracking annotation naming a different application', () => {
  // Catches the annotation source dropped, or read out of the label map, and the tracking id
  // parsed anywhere but before the first colon: taking the whole value, the second
  // colon-separated segment, or splitting on "/" all yield something other than root-app from
  // "root-app:argoproj.io/Application:argocd/child-app".
  const result = detectDurability({
    metadata: {
      name: 'child-app',
      annotations: {
        'argocd.argoproj.io/tracking-id': 'root-app:argoproj.io/Application:argocd/child-app'
      }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'root-app' });
  assert.match(result.note ?? '', /selfHeal/);
  assert.doesNotMatch(result.note ?? '', /ignoreApplicationDifferences/);
});

test('detectDurability ignores a tracking label naming the application itself', () => {
  // The worst false positive available here: Argo CD labels the resources an application
  // manages, and an application that manages its own namespace appears in its own resource
  // set, so dropping the self-reference check reports ordinary applications as unsafe to write
  // to and makes the warning meaningless.
  assert.deepEqual(
    detectDurability({
      metadata: { name: 'my-app', labels: { 'app.kubernetes.io/instance': 'my-app' } }
    }),
    { durable: true }
  );
});

test('detectDurability ignores a tracking annotation naming the application itself', () => {
  // The annotation half of the same check, and it only holds if the comparison runs on the
  // parsed app name: comparing the raw tracking id against metadata.name never matches, so
  // this self-tracking application would be reported as externally managed.
  assert.deepEqual(
    detectDurability({
      metadata: {
        name: 'my-app',
        annotations: {
          'argocd.argoproj.io/tracking-id': 'my-app:argoproj.io/Application:argocd/my-app'
        }
      }
    }),
    { durable: true }
  );
});

test('detectDurability reads the tracking annotation when the label names this application', () => {
  // Stopping at the first tracking value present — `label ?? annotation` — sees this
  // application's own name in the label, clears the self-reference check and reports durable
  // while the annotation names a parent. Reachable whenever the chart that renders the child
  // Application templates app.kubernetes.io/instance from its own release name, and it is the
  // silent case: no warning at all, which is worse than a wrong parent name in the note.
  const result = detectDurability({
    metadata: {
      name: 'child-app',
      labels: { 'app.kubernetes.io/instance': 'child-app' },
      annotations: {
        'argocd.argoproj.io/tracking-id': 'root-app:argoproj.io/Application:argocd/child-app'
      }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'root-app' });
});

test('detectDurability names the annotation parent when the two tracking values disagree', () => {
  // Catches the two sources consulted in the other order. The tracking id is the authoritative
  // value — the label is a copy capped at Kubernetes' 63-character limit for label values, and
  // a chart is free to set app.kubernetes.io/instance for reasons of its own.
  const result = detectDurability({
    metadata: {
      name: 'child-app',
      labels: { 'app.kubernetes.io/instance': 'label-parent' },
      annotations: {
        'argocd.argoproj.io/tracking-id':
          'annotation-parent:argoproj.io/Application:argocd/child-app'
      }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'annotation-parent' });
});

test('detectDurability reports durable when no management signal is present', () => {
  // The ordinary application, and the shape Task 11 puts in the response: deepEqual pins that
  // managedBy and note are absent rather than present-and-empty, which asserting durable alone
  // would not. Empty maps and a missing metadata block are the same answer — the last two
  // reject a truthiness slip that treats an empty label value as a parent name.
  assert.deepEqual(detectDurability({ metadata: { name: 'my-app' } }), { durable: true });
  assert.deepEqual(detectDurability({ metadata: {} }), { durable: true });
  assert.deepEqual(detectDurability({}), { durable: true });
  assert.deepEqual(
    detectDurability({
      metadata: { name: 'my-app', labels: { 'app.kubernetes.io/instance': '' }, annotations: {} }
    }),
    { durable: true }
  );
});

test('detectDurability prefers the ApplicationSet signal over the tracking signal', () => {
  // Catches inverted precedence. A generated Application carries the parent's tracking values
  // whenever the ApplicationSet is itself managed by an app-of-apps, and only the
  // ApplicationSet reason is actionable there: writing to the child is pointless because the
  // controller reconciles it back to the template regardless of the parent's selfHeal setting.
  const result = detectDurability({
    metadata: {
      name: 'child',
      ownerReferences: [{ kind: 'ApplicationSet', name: 'prod-apps' }],
      labels: { 'app.kubernetes.io/instance': 'root-app' },
      annotations: {
        'argocd.argoproj.io/tracking-id': 'root-app:argoproj.io/Application:argocd/child'
      }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'ApplicationSet', name: 'prod-apps' });
  assert.match(result.note ?? '', /ignoreApplicationDifferences/);
  assert.match(result.note ?? '', /will be reverted/);
  assert.doesNotMatch(result.note ?? '', /preservedFields/);
  assert.doesNotMatch(result.note ?? '', /selfHeal/);
});

test('detectDurability skips a tracking id with no application name and reads the label', () => {
  // Catches a candidate scan that stops at the first value that merely exists rather than the
  // first usable one: a tracking id whose app-name segment is empty would then shadow the
  // label and suppress the warning altogether, which is the one outcome with no recovery —
  // the caller never learns the write is going to be reverted.
  const result = detectDurability({
    metadata: {
      name: 'child-app',
      labels: { 'app.kubernetes.io/instance': 'root-app' },
      annotations: { 'argocd.argoproj.io/tracking-id': ':argoproj.io/Application:argocd/child-app' }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'root-app' });
});

test('detectDurability flags a parent whose name extends this application name', () => {
  // The self-check has to be exact equality. A prefix comparison —
  // `!candidate.startsWith(metadata.name)`, the shape a maintainer reaches for when narrowing
  // the 63-character truncation case documented in the source — passes every other test here,
  // because every name pair in them is prefix-disjoint. Under it a child named web with parent
  // web-apps gets no warning at all, and "web" / "web-apps" is an ordinary naming convention.
  const result = detectDurability({
    metadata: { name: 'web', labels: { 'app.kubernetes.io/instance': 'web-apps' } }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'web-apps' });
});

test('detectDurability warns from the label when the tracking annotation names this application', () => {
  // Turns the documented lean into an enforced decision. Consulting the annotation alone once
  // it is present — annotation ?? label — makes this application self-tracked and silent, which
  // is also defensible; this pins the other direction, that a label naming someone else is
  // still reported. The choice is the asymmetry: a warning the caller can dismiss costs a
  // second look, a missed one is a change that disappears with no signal.
  const result = detectDurability({
    metadata: {
      name: 'app',
      labels: { 'app.kubernetes.io/instance': 'other' },
      annotations: { 'argocd.argoproj.io/tracking-id': 'app:argoproj.io/Application:argocd/app' }
    }
  });
  assert.equal(result.durable, false);
  assert.deepEqual(result.managedBy, { kind: 'Application', name: 'other' });
});
