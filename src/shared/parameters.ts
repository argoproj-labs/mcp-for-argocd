// Pure transformations over an Argo CD Application source block. No I/O and no
// dependency on the HTTP client, so every rule here is unit-testable without an
// Argo CD instance.
//
// Local types are used instead of the generated ones because two generated types
// do not describe the wire format: V1alpha1KustomizeReplica.count is declared as
// the IntstrIntOrString struct but serializes as a bare int or string, and
// valuesObject is declared as RuntimeRawExtension. The index signatures keep
// fields this feature does not model (releaseName, version, skipCrds, ...) alive
// through the clone-and-merge.

export type HelmParameter = { name?: string; value?: string; forceString?: boolean };
export type HelmFileParameter = { name?: string; path?: string };

export type HelmBlock = {
  parameters?: HelmParameter[];
  fileParameters?: HelmFileParameter[];
  valueFiles?: string[];
  values?: string;
  valuesObject?: unknown; // a RuntimeRawExtension on the wire: an arbitrary YAML/JSON tree
  [key: string]: unknown;
};

export type KustomizeReplica = {
  name?: string;
  count?: number | string; // bare int or string on the wire, not IntstrIntOrString
};

export type KustomizeBlock = {
  images?: string[];
  replicas?: KustomizeReplica[];
  namePrefix?: string;
  nameSuffix?: string;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  [key: string]: unknown;
};

export type AppSource = {
  repoURL?: string;
  helm?: HelmBlock;
  kustomize?: KustomizeBlock;
  [key: string]: unknown;
};

export type AppSpec = {
  source?: AppSource;
  sources?: AppSource[];
  [key: string]: unknown;
};

export type HelmOverrides = {
  parameters?: HelmParameter[];
  fileParameters?: HelmFileParameter[];
  valueFiles?: string[];
  values?: string;
  valuesObject?: Record<string, unknown>;
};

export type KustomizeOverrides = {
  images?: string[];
  replicas?: KustomizeReplica[];
  namePrefix?: string;
  nameSuffix?: string;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
};

export type HelmUnset = {
  parameters?: string[];
  fileParameters?: string[];
  valueFiles?: string[];
  values?: boolean;
  valuesObject?: boolean;
};

export type KustomizeUnset = {
  images?: string[];
  replicas?: string[];
  namePrefix?: boolean;
  nameSuffix?: boolean;
  commonLabels?: string[];
  commonAnnotations?: string[];
};

export type ParameterUnset = { helm?: HelmUnset; kustomize?: KustomizeUnset };

export type ParameterOverrides = {
  helm?: HelmOverrides;
  kustomize?: KustomizeOverrides;
  unset?: ParameterUnset;
};

// One entry per field actually changed. `key` is present only for keyed lists and
// maps; scalar fields omit it. `from` is null when the field had no prior value,
// and `to` is absent for unset operations.
export type ParameterChange = {
  field: string;
  op: 'set' | 'unset';
  key?: string;
  from: unknown;
  to?: unknown;
};

// Resolve which source the overrides apply to. Every mismatch throws with a
// message that tells the caller what to send instead — the tool surfaces these
// verbatim, so a model can correct itself without a second read.
export const resolveTargetSource = (spec: AppSpec, sourceIndex?: number): AppSource => {
  const sources = spec.sources;
  const isMultiSource = Array.isArray(sources) && sources.length > 0;

  if (!isMultiSource) {
    // Having no source at all is reported before anything about sourceIndex,
    // including for `sources: []`: telling that caller to omit sourceIndex would
    // send them in a circle, because omitting it cannot conjure a source.
    if (!spec.source) {
      throw new Error('This application has no source to apply parameter overrides to.');
    }
    if (sourceIndex !== undefined) {
      throw new Error(
        'This application has a single source, so sourceIndex does not apply. Omit sourceIndex.'
      );
    }
    return spec.source;
  }

  if (sourceIndex === undefined) {
    const listing = sources.map((s, i) => `  ${i}: ${s.repoURL ?? '(no repoURL)'}`).join('\n');
    throw new Error(
      `This application uses the multi-source form (spec.sources), so sourceIndex is required. Available sources:\n${listing}`
    );
  }
  // Number.isInteger also rejects NaN, which would otherwise pass both
  // comparisons and index the array to undefined.
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= sources.length) {
    throw new Error(
      `sourceIndex ${sourceIndex} is out of range: this application has ${sources.length} source(s), valid indexes 0 to ${sources.length - 1}.`
    );
  }
  return sources[sourceIndex];
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Label and annotation keys come from the caller, and "toString", "valueOf",
// "constructor" and "hasOwnProperty" are all valid Kubernetes names — so `key in map`
// and a bare `map[key]` read would reach Object.prototype and see values the map never
// held. Object.hasOwn would say this in one call but is ES2022, past our target.
const hasOwn = (obj: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

// Mirrors Argo CD's KustomizeImage.Match/delim: the delimiter is chosen by
// priority across the whole string — the first of "=", ":", "@" found anywhere
// wins — and the key is everything before its first occurrence. That is not "the
// first delimiter character in the string": "localhost:5000/nginx=repo:1.0" keys
// on "localhost:5000/nginx", not "localhost", because "=" outranks ":".
//
// Two consequences look like bugs and are not. Both follow from ":" outranking
// "@", and both are what `argocd app set --kustomize-image` already does, so
// please do not "fix" them here — a key that disagrees with Argo CD's Match()
// would make this tool and the CLI produce different images lists from the same
// input. If the behavior should change, it changes upstream in Argo CD.
//
//   - A ported image with no "=", "localhost:5000/nginx:1.2", keys on "localhost".
//   - A digest image, "nginx@sha256:abc", keys on "nginx@sha256" — so retagging
//     "nginx:1.2" to a digest appends a second entry instead of replacing it.
export const kustomizeImageKey = (image: string): string => {
  for (const delim of ['=', ':', '@']) {
    const idx = image.indexOf(delim);
    if (idx !== -1) {
      return image.slice(0, idx);
    }
  }
  return image;
};

// Every helper below returns its input untouched when it recorded no change, so the
// caller can assign the result unconditionally and still end up with a byte-identical
// spec. Emptiness is not normalized on the way in — only a list this call actually
// emptied becomes undefined — because `helm: { parameters: [] }` from a caller must not
// turn into a written-out empty override that Argo CD would treat as live.
//
// "Recorded no change" is measured against the length `changes` had on entry, never
// against zero: one array accumulates across every helper in a merge.

// `isEqual` replaces the default structural comparison when a field's wire format makes two
// encodings of the same value compare unequal — a replica count is an IntOrString, so 3 and
// '3' mean the same thing. It settles only the did-this-entry-change question: keying still
// goes through `keyOf`, and the value stored is the caller's `item`, never a normalized one.
export const upsertKeyed = <T>(
  list: T[] | undefined,
  incoming: T[],
  keyOf: (item: T) => string,
  field: string,
  changes: ParameterChange[],
  isEqual?: (a: T, b: T) => boolean
): T[] | undefined => {
  const before = changes.length;
  const result = [...(list ?? [])];
  for (const item of incoming) {
    const key = keyOf(item);
    const idx = result.findIndex((existing) => keyOf(existing) === key);
    if (idx === -1) {
      result.push(item);
      changes.push({ field, op: 'set', key, from: null, to: item });
    } else if (!(isEqual ?? sameValue)(result[idx], item)) {
      changes.push({ field, op: 'set', key, from: result[idx], to: item });
      result[idx] = item;
    }
  }
  return changes.length === before ? list : result;
};

export const removeKeyed = <T>(
  list: T[] | undefined,
  keys: string[],
  keyOf: (item: T) => string,
  field: string,
  changes: ParameterChange[]
): T[] | undefined => {
  if (!list) {
    return undefined;
  }
  const before = changes.length;
  const result = list.filter((item) => {
    if (!keys.includes(keyOf(item))) {
      return true;
    }
    changes.push({ field, op: 'unset', key: keyOf(item), from: item });
    return false;
  });
  if (changes.length === before) {
    return list;
  }
  return result.length > 0 ? result : undefined;
};

// A plain string list is a keyed list keyed on the value itself: a value either equals
// an entry already there, leaving nothing to do, or it is absent and gets appended.
// Delegating keeps one implementation of the change-recording and no-op rules.
const identity = (value: string): string => value;

export const appendUnique = (
  list: string[] | undefined,
  incoming: string[],
  field: string,
  changes: ParameterChange[]
): string[] | undefined => upsertKeyed(list, incoming, identity, field, changes);

export const removeFromList = (
  list: string[] | undefined,
  values: string[],
  field: string,
  changes: ParameterChange[]
): string[] | undefined => removeKeyed(list, values, identity, field, changes);

export const setScalar = <T>(
  current: T | undefined,
  next: T | undefined,
  field: string,
  changes: ParameterChange[]
): T | undefined => {
  if (next === undefined || sameValue(current, next)) {
    return current;
  }
  changes.push({ field, op: 'set', from: current ?? null, to: next });
  return next;
};

export const unsetScalar = <T>(
  current: T | undefined,
  remove: boolean | undefined,
  field: string,
  changes: ParameterChange[]
): T | undefined => {
  // `== null` on purpose: a spec may hold the field as an explicit null, which Argo CD
  // already treats as absent, so there is nothing to unset and nothing to report.
  if (!remove || current == null) {
    return current;
  }
  changes.push({ field, op: 'unset', from: current });
  return undefined;
};

export const mergeMap = (
  current: Record<string, string> | undefined,
  incoming: Record<string, string>,
  field: string,
  changes: ParameterChange[]
): Record<string, string> | undefined => {
  const before = changes.length;
  const result = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = hasOwn(result, key) ? result[key] : undefined;
    if (existing !== value) {
      changes.push({ field, op: 'set', key, from: existing ?? null, to: value });
      result[key] = value;
    }
  }
  return changes.length === before ? current : result;
};

export const removeMapKeys = (
  current: Record<string, string> | undefined,
  keys: string[],
  field: string,
  changes: ParameterChange[]
): Record<string, string> | undefined => {
  if (!current) {
    return undefined;
  }
  const before = changes.length;
  const result = { ...current };
  for (const key of keys) {
    if (hasOwn(result, key)) {
      changes.push({ field, op: 'unset', key, from: result[key] });
      delete result[key];
    }
  }
  if (changes.length === before) {
    return current;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

// Helm parameters, helm file parameters and kustomize replicas are all keyed on `name`.
// sameReplica calls this too, so the comparator and the merge cannot disagree about what a
// replica's key is.
const nameKey = (item: { name?: string }): string => item.name ?? '';

// Delete the key rather than assigning undefined. Every helper above returns its input
// untouched when it recorded no change, so that a no-op merge yields a block identical to
// the source one — and an own key holding undefined would break that: it still shows up in
// Object.keys and makes deepStrictEqual report a difference, even though JSON.stringify
// hides it. Deleting also keeps a caller's `{ parameters: [] }` from materializing an empty
// override container, which Argo CD treats differently from an absent one.
const assign = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void => {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
};

// Compose the helpers into the helm half of a merge. Unset runs before set, which is what
// lets one call replace a list wholesale — unset the entries to drop, set the ones to keep —
// in a single spec write. That matters because on an auto-sync application every write is a
// deploy. The block is spread rather than rebuilt so that fields this feature does not model
// (releaseName, version, skipCrds, ...) survive.
export const applyHelmOverrides = (
  helm: HelmBlock | undefined,
  set: HelmOverrides | undefined,
  unset: HelmUnset | undefined
): { helm: HelmBlock | undefined; changes: ParameterChange[] } => {
  const changes: ParameterChange[] = [];
  if (!set && !unset) {
    return { helm, changes };
  }

  const next: HelmBlock = { ...(helm ?? {}) };

  if (unset) {
    if (unset.parameters) {
      assign(
        next,
        'parameters',
        removeKeyed(next.parameters, unset.parameters, nameKey, 'helm.parameters', changes)
      );
    }
    if (unset.fileParameters) {
      assign(
        next,
        'fileParameters',
        removeKeyed(
          next.fileParameters,
          unset.fileParameters,
          nameKey,
          'helm.fileParameters',
          changes
        )
      );
    }
    if (unset.valueFiles) {
      assign(
        next,
        'valueFiles',
        removeFromList(next.valueFiles, unset.valueFiles, 'helm.valueFiles', changes)
      );
    }
    assign(next, 'values', unsetScalar(next.values, unset.values, 'helm.values', changes));
    assign(
      next,
      'valuesObject',
      unsetScalar(next.valuesObject, unset.valuesObject, 'helm.valuesObject', changes)
    );
  }

  if (set) {
    if (set.parameters) {
      assign(
        next,
        'parameters',
        upsertKeyed(next.parameters, set.parameters, nameKey, 'helm.parameters', changes)
      );
    }
    if (set.fileParameters) {
      assign(
        next,
        'fileParameters',
        upsertKeyed(
          next.fileParameters,
          set.fileParameters,
          nameKey,
          'helm.fileParameters',
          changes
        )
      );
    }
    if (set.valueFiles) {
      assign(
        next,
        'valueFiles',
        appendUnique(next.valueFiles, set.valueFiles, 'helm.valueFiles', changes)
      );
    }
    assign(next, 'values', setScalar(next.values, set.values, 'helm.values', changes));
    assign(
      next,
      'valuesObject',
      setScalar(next.valuesObject, set.valuesObject, 'helm.valuesObject', changes)
    );
  }

  // Nothing changed and there was no block to begin with: leave the source alone rather than
  // adding an empty helm section.
  if (changes.length === 0 && !helm) {
    return { helm: undefined, changes };
  }
  return { helm: next, changes };
};

// A replica count is a Kubernetes IntOrString, so the same count reaches us as 3 from a
// CLI-style override and as '3' from a YAML-authored Application. Comparing the two entries
// structurally would call them different, record a change, and rewrite the spec on every
// call — and on an auto-sync application every write is a deploy, so the tool would look like
// it keeps redeploying replicas.
//
// Only the comparison normalizes: whatever the caller sent is what lands in the spec, so
// `count: 3` is written as 3. That still terminates, because the value written is by
// construction one this comparison calls equal to itself on the next call.
//
// This compares the two fields KustomizeReplica models. A field added to that type has to be
// added here too, or a change to it would silently no-op.
const sameReplica = (a: KustomizeReplica, b: KustomizeReplica): boolean =>
  nameKey(a) === nameKey(b) && String(a.count) === String(b.count);

// The kustomize half of a merge, on the same shape as applyHelmOverrides: unset before set,
// the set branch reading its current values from the working copy so that unsetting a list and
// setting it in one call replaces it wholesale, and the block spread rather than rebuilt so
// unmodelled fields (version, forceCommonLabels, patches, ...) survive.
export const applyKustomizeOverrides = (
  kustomize: KustomizeBlock | undefined,
  set: KustomizeOverrides | undefined,
  unset: KustomizeUnset | undefined
): { kustomize: KustomizeBlock | undefined; changes: ParameterChange[] } => {
  const changes: ParameterChange[] = [];
  if (!set && !unset) {
    return { kustomize, changes };
  }

  const next: KustomizeBlock = { ...(kustomize ?? {}) };

  if (unset) {
    if (unset.images) {
      assign(
        next,
        'images',
        removeKeyed(next.images, unset.images, kustomizeImageKey, 'kustomize.images', changes)
      );
    }
    if (unset.replicas) {
      assign(
        next,
        'replicas',
        removeKeyed(next.replicas, unset.replicas, nameKey, 'kustomize.replicas', changes)
      );
    }
    if (unset.commonLabels) {
      assign(
        next,
        'commonLabels',
        removeMapKeys(next.commonLabels, unset.commonLabels, 'kustomize.commonLabels', changes)
      );
    }
    if (unset.commonAnnotations) {
      assign(
        next,
        'commonAnnotations',
        removeMapKeys(
          next.commonAnnotations,
          unset.commonAnnotations,
          'kustomize.commonAnnotations',
          changes
        )
      );
    }
    assign(
      next,
      'namePrefix',
      unsetScalar(next.namePrefix, unset.namePrefix, 'kustomize.namePrefix', changes)
    );
    assign(
      next,
      'nameSuffix',
      unsetScalar(next.nameSuffix, unset.nameSuffix, 'kustomize.nameSuffix', changes)
    );
  }

  if (set) {
    if (set.images) {
      assign(
        next,
        'images',
        upsertKeyed(next.images, set.images, kustomizeImageKey, 'kustomize.images', changes)
      );
    }
    if (set.replicas) {
      assign(
        next,
        'replicas',
        upsertKeyed(
          next.replicas,
          set.replicas,
          nameKey,
          'kustomize.replicas',
          changes,
          sameReplica
        )
      );
    }
    if (set.commonLabels) {
      assign(
        next,
        'commonLabels',
        mergeMap(next.commonLabels, set.commonLabels, 'kustomize.commonLabels', changes)
      );
    }
    if (set.commonAnnotations) {
      assign(
        next,
        'commonAnnotations',
        mergeMap(
          next.commonAnnotations,
          set.commonAnnotations,
          'kustomize.commonAnnotations',
          changes
        )
      );
    }
    assign(
      next,
      'namePrefix',
      setScalar(next.namePrefix, set.namePrefix, 'kustomize.namePrefix', changes)
    );
    assign(
      next,
      'nameSuffix',
      setScalar(next.nameSuffix, set.nameSuffix, 'kustomize.nameSuffix', changes)
    );
  }

  // Nothing changed and there was no block to begin with: leave the source alone rather than
  // adding an empty kustomize section.
  if (changes.length === 0 && !kustomize) {
    return { kustomize: undefined, changes };
  }
  return { kustomize: next, changes };
};

// Run both halves over one deep clone. The clone is not a defensive habit: the caller keeps the
// original source for buildPatchOps, which reads the pre-merge values to build the `test` ops that
// make the write fail rather than clobber a concurrent change. Going through JSON also launders a
// source read from the API into a plain object — the generated Argo CD types carry no index
// signature and so are not assignable to AppSource.
//
// Both halves return their input block untouched when they record nothing, and `assign` deletes on
// undefined, so a merge that changes nothing yields a source with the same key set as the input.
export const applyParameterOverrides = (
  source: AppSource,
  overrides: ParameterOverrides
): { source: AppSource; changes: ParameterChange[] } => {
  const next: AppSource = JSON.parse(JSON.stringify(source));
  const changes: ParameterChange[] = [];

  const helmResult = applyHelmOverrides(next.helm, overrides.helm, overrides.unset?.helm);
  assign(next, 'helm', helmResult.helm);
  changes.push(...helmResult.changes);

  const kustomizeResult = applyKustomizeOverrides(
    next.kustomize,
    overrides.kustomize,
    overrides.unset?.kustomize
  );
  assign(next, 'kustomize', kustomizeResult.kustomize);
  changes.push(...kustomizeResult.changes);

  return { source: next, changes };
};

export type PatchOp = { op: 'test' | 'add' | 'remove'; path: string; value?: unknown };

// An emptied field arrives in one of three shapes: `assign` deleted the key, so the read is
// undefined, or the caller's own after-block carries a container that holds nothing. All three
// mean "absent" to Argo CD, and all three have to become a `remove` rather than a write of an
// empty container, which Argo CD would treat as a live override. Falsiness is not the test: ''
// is a legitimate value for helm.values.
const isEmptyValue = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

// Whether an override block holds anything at all, by the same emptiness rule
// buildPatchOps writes with. An Argo CD source's type is single-valued, so a caller has to
// be told before a write that would leave two blocks set — and the check has to be
// emptiness rather than presence, because `{}` is what unsetting a block's last field
// leaves behind and Go's IsZero() reads that as no block at all. Reading presence would
// refuse the one call that repairs a source already carrying both.
export const isNonEmptyBlock = (block: unknown): boolean =>
  typeof block === 'object' &&
  block !== null &&
  Object.values(block).some((value) => !isEmptyValue(value));

// Build the narrowest RFC 6902 document that expresses the merge.
//
// Per-field ops rather than one op for the whole block: replacing the whole block
// would also rewrite fields this feature does not model (releaseName, version,
// skipCrds) with their read-time values, reverting any concurrent edit to them —
// the clobbering that PATCH was chosen to avoid. The exception is a block that did
// not exist at read time, where a per-field op would fail because RFC 6902 `add`
// cannot create intermediate paths.
//
// Each changed field that existed at read time gets a `test` op carrying its
// read-time value, so a concurrent write to that same field aborts the patch
// instead of being silently dropped from our merge. The `test` op deliberately
// targets the field itself and never /metadata/resourceVersion: the application
// controller writes status continuously, so a resourceVersion compare-and-swap
// would fail on unrelated activity — and fail hardest on a Progressing app, which
// is exactly when changing a parameter is most urgent.
export const buildPatchOps = (
  sourceIndex: number | undefined,
  before: AppSource,
  after: AppSource,
  changes: ParameterChange[]
): PatchOp[] => {
  if (changes.length === 0) {
    return [];
  }

  const basePath = sourceIndex === undefined ? '/spec/source' : `/spec/sources/${sourceIndex}`;
  const ops: PatchOp[] = [];

  for (const block of ['helm', 'kustomize'] as const) {
    // One op pair per changed field, not one per change: two parameters set on the same
    // field are one write, and a second `test` op for it would compare the read-time value
    // against what the first op just wrote and fail.
    const touchedFields = [
      ...new Set(
        changes
          .filter((change) => change.field.startsWith(`${block}.`))
          .map((change) => change.field.slice(block.length + 1))
      )
    ];
    if (touchedFields.length === 0) {
      continue;
    }

    const blockBefore = before[block] as Record<string, unknown> | undefined;
    const blockAfter = after[block] as Record<string, unknown> | undefined;

    if (!blockBefore) {
      // Every field of a block that did not exist is absent at read time, so the empty-value
      // rule below applies to all of them at once: an empty field is already the state on the
      // server. Sending them would materialize a block holding nothing but empty override
      // containers, and a spec write on an auto-sync application is a deploy.
      const value: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(blockAfter ?? {})) {
        if (!isEmptyValue(fieldValue)) {
          value[field] = fieldValue;
        }
      }
      if (Object.keys(value).length > 0) {
        ops.push({ op: 'add', path: `${basePath}/${block}`, value });
      }
      continue;
    }

    for (const field of touchedFields) {
      const path = `${basePath}/${block}/${field}`;
      // Own-property check rather than `in`: the same reason hasOwn exists above, kept here
      // so a field name can never resolve through Object.prototype.
      const existed = Object.prototype.hasOwnProperty.call(blockBefore, field);
      const nextValue = blockAfter?.[field];
      const emptied = isEmptyValue(nextValue);
      // Absent at read time and still empty — the state the caller asked for is already
      // the state on the server, and a `remove` op would fail the whole patch because
      // RFC 6902 requires the target location to exist.
      if (emptied && !existed) {
        continue;
      }
      if (existed) {
        ops.push({ op: 'test', path, value: blockBefore[field] });
      }
      ops.push(emptied ? { op: 'remove', path } : { op: 'add', path, value: nextValue });
    }
  }

  return ops;
};

export type Durability = {
  durable: boolean;
  managedBy?: { kind: string; name: string };
  note?: string;
};

// Only the metadata this check reads. The generated V1alpha1Application declares all four of
// these optional, so every read here is guarded.
export type DurabilityInput = {
  metadata?: {
    name?: string;
    ownerReferences?: { kind?: string; name?: string }[];
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
};

const TRACKING_LABEL = 'app.kubernetes.io/instance';
const TRACKING_ANNOTATION = 'argocd.argoproj.io/tracking-id';

// Report whether a parameter override written to this application will survive.
//
// Two ordinary setups revert it on the next reconcile and raise no error anywhere:
// ApplicationSet-generated applications, where preservedFields can hold on to annotations and
// labels but never spec.source, and app-of-apps children, whose spec is rendered from the
// parent's git revision and restored by selfHeal. Unreported, that is the worst outcome the
// feature can produce — an accurate change list for a change that quietly disappears.
//
// This warns rather than refusing. A generated application's override does survive when the
// parent ApplicationSet sets ignoreApplicationDifferences for the path, and that cannot be seen
// from the application alone, so refusing would break the setups that got this right.
export const detectDurability = (app: DurabilityInput): Durability => {
  const metadata = app.metadata;
  const appSetOwner = metadata?.ownerReferences?.find((ref) => ref.kind === 'ApplicationSet');
  // Checked first: an ApplicationSet-generated child also carries the tracking values of
  // whatever manages the ApplicationSet, and only this reason is actionable — the controller
  // reconciles the generated spec back to the template no matter what selfHeal is set to.
  //
  // Known gap, and the one most worth closing: this detection is owner-reference-based, and
  // Kubernetes forbids a cross-namespace owner reference. Under the "ApplicationSets in any
  // namespace" topology — an ApplicationSet in argocd generating applications into per-team
  // namespaces — the generated application carries no owner reference, so it is reported durable
  // when it is not. Argo CD may also label a generated application with its ApplicationSet's
  // name, which would close the gap, but that key is in neither the generated types here nor
  // anything verifiable from this repo, and reading a guessed key would invent behaviour. Left
  // unhandled on purpose until the key can be cited for a targeted Argo CD version.
  if (appSetOwner) {
    return {
      durable: false,
      managedBy: { kind: 'ApplicationSet', name: appSetOwner.name ?? '' },
      note: 'This application is generated by an ApplicationSet, so the override will be reverted on the next reconcile unless that ApplicationSet leaves this path alone — usually ignoreApplicationDifferences for it, or an applicationsSync policy that does not update generated applications, such as create-only.'
    };
  }

  // Argo CD names the application managing a resource twice over: in the tracking id
  // annotation, whose value is "<app-name>:<group>/<kind>:<namespace>/<name>", and in the
  // instance label. Both are consulted, because either can be the only one present and either
  // can name a parent the other does not — the annotation first, since it carries the
  // authoritative name while the label is a copy capped at 63 characters and can also be set
  // by whatever chart rendered this manifest.
  //
  // A value naming this application itself is Argo CD tracking its own resources, not external
  // management: an application that manages the namespace it lives in appears in its own
  // resource set. Warning on that would flag ordinary applications as unsafe to write to.
  //
  // Two cases where the two values disagree resolve toward warning, deliberately: a label
  // truncated at Kubernetes' 63-character limit stops comparing equal to a longer metadata.name,
  // and a chart may set the instance label to something unrelated while the annotation names
  // this application. Both name a parent that is not one. Neither is narrowed here, because
  // doing so means reproducing Argo CD's truncation rule or guessing at a chart's intent from
  // the application alone — and the direction is the safe one either way: a warning the caller
  // can evaluate costs a second look, while a missed one is a change that disappears silently.
  const trackingId = metadata?.annotations?.[TRACKING_ANNOTATION];
  const trackers = [trackingId?.split(':')[0], metadata?.labels?.[TRACKING_LABEL]];
  const tracker = trackers.find((candidate) => candidate && candidate !== metadata?.name);
  if (tracker) {
    return {
      durable: false,
      managedBy: { kind: 'Application', name: tracker },
      note: `This application is managed by the parent application "${tracker}", so the override will be reverted on the next reconcile if that application has selfHeal enabled.`
    };
  }

  return { durable: true };
};
