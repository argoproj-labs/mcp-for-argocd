import { V1alpha1HelmParameter } from '../types/argocd-types.js';

export type HelmParameterUpdate = {
  name: string;
  value: string;
};

// Replace the value of every existing parameter with the same name. Names that
// are not already present are appended. Entries that are not named in updates
// stay in the list, including fields such as forceString.
export function upsertHelmParameters(
  existing: V1alpha1HelmParameter[] | undefined,
  updates: HelmParameterUpdate[]
): V1alpha1HelmParameter[] {
  if (updates.length === 0) {
    throw new Error('helm parameter updates are empty');
  }
  const parameters = (existing ?? []).map((param) => ({ ...param }));
  for (const update of updates) {
    const name = update.name.trim();
    if (!name) {
      throw new Error('helm parameter name is empty');
    }
    if (update.value === '') {
      throw new Error(`helm parameter "${name}" value is empty`);
    }
    let found = false;
    for (const param of parameters) {
      if (param.name === name) {
        param.value = update.value;
        found = true;
      }
    }
    if (!found) {
      parameters.push({ name, value: update.value });
    }
  }
  return parameters;
}
