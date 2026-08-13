import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { logger } from '../logging/logging.js';
import { TokenRegistry, type TokenRegistryEntry } from '../server/tokenRegistry.js';

// Reads the Argo CD CLI's local config file (the one written by `argocd login`,
// `argocd context`, etc.) and turns its contexts into selectable MCP profiles.
//
// This lets the server reuse the credentials a user already has — including
// tokens obtained via SSO/OIDC or LDAP through `argocd login --sso` — instead
// of duplicating them into a separate file. Each context becomes a profile
// (name -> base URL + token), and the file's `current-context` becomes the
// default/active profile.
//
// The config is read ONLY when an explicit path is provided (the ARGOCD_CONFIG
// env var or the --config CLI flag); the default `~/.config/argocd/config`
// location is never read implicitly. Tokens are secrets, so reading them from
// the user's own protected file keeps them out of tool-call payloads, prompts,
// and model context, exactly like the rest of the credential handling.

// The relevant subset of the Argo CD CLI config file. Field names match the
// YAML keys written by the argocd CLI (see argo-cd util/localconfig).
type ArgoCdContext = {
  name?: string;
  server?: string;
  user?: string;
};

type ArgoCdServer = {
  server?: string;
  // When true the server is served over plain HTTP rather than HTTPS.
  'plain-text'?: boolean;
};

type ArgoCdUser = {
  name?: string;
  'auth-token'?: string;
};

type ArgoCdLocalConfig = {
  contexts?: ArgoCdContext[];
  servers?: ArgoCdServer[];
  users?: ArgoCdUser[];
  'current-context'?: string;
};

// Build the base URL the MCP server should call for a given context. The config
// stores a bare host (e.g. "argocd.example.com"); the REST API is HTTPS unless
// the matching server entry is marked plain-text.
const toBaseUrl = (server: string, plainText: boolean): string =>
  `${plainText ? 'http' : 'https'}://${server}`;

// Parse the raw YAML contents of an Argo CD CLI config file into profile
// registry entries plus the name of the current context (the default profile).
// Throws on malformed YAML — an operator who pointed us at a config file expects
// it to be usable, so we surface the problem loudly rather than silently degrade.
export const parseArgoCdLocalConfig = (
  raw: string
): { entries: TokenRegistryEntry[]; currentContext?: string } => {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new Error(
      `Argo CD config file is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Argo CD config file must contain a YAML mapping');
  }
  const config = parsed as ArgoCdLocalConfig;

  // Index servers and users by their key so contexts can be resolved to a base
  // URL and token.
  const serverByName = new Map<string, ArgoCdServer>();
  for (const server of config.servers ?? []) {
    if (server.server) serverByName.set(server.server, server);
  }
  const userByName = new Map<string, ArgoCdUser>();
  for (const user of config.users ?? []) {
    if (user.name) userByName.set(user.name, user);
  }

  const currentContext = config['current-context']?.trim() || undefined;
  const entries: TokenRegistryEntry[] = [];
  for (const context of config.contexts ?? []) {
    const name = context.name?.trim();
    const server = context.server?.trim();
    if (!name || !server) continue;

    const token = userByName.get(context.user ?? name)?.['auth-token']?.trim();
    if (!token) {
      // A context with no auth-token can't be used (e.g. never logged in, or an
      // expired session). Skip it rather than fail the whole file, but say so.
      logger.warn(`Skipping Argo CD context "${name}": no auth-token (run \`argocd login\`?)`);
      continue;
    }

    const plainText = serverByName.get(server)?.['plain-text'] === true;
    entries.push({
      name,
      baseUrl: toBaseUrl(server, plainText),
      token,
      default: name === currentContext
    });
  }
  return { entries, currentContext };
};

// Read + parse the config file at `path` into a TokenRegistry. Throws (fails
// closed) when the file is unreadable or malformed.
const loadRegistryFromFile = (path: string): TokenRegistry => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read Argo CD config file at "${path}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const { entries } = parseArgoCdLocalConfig(raw);
  return new TokenRegistry(entries);
};

const pluralProfiles = (n: number): string => `${n} Argo CD profile${n === 1 ? '' : 's'}`;

// Build a TokenRegistry from the Argo CD CLI config at `configPath`. When no
// path is provided the registry is empty (the feature is opt-in: the default
// `~/.config/argocd/config` location is never read implicitly). When a path IS
// provided this fails closed — an unreadable or malformed file throws so the
// process crashes at startup rather than silently running with no profiles.
export const tokenRegistryFromArgoCdConfig = (
  configPath: string | undefined = process.env.ARGOCD_CONFIG
): TokenRegistry => {
  const path = configPath?.trim();
  if (!path) {
    return new TokenRegistry();
  }
  const registry = loadRegistryFromFile(path);
  logger.info(`Loaded ${pluralProfiles(registry.listProfiles().length)} from "${path}"`);
  return registry;
};

// A live view over the profile registry. `get()` returns the currently loaded
// registry (cheap, no I/O); `reload()` re-reads the Argo CD config file and
// swaps in the refreshed registry, returning it.
//
// Reloading is opportunistic — the profile tools (list_profiles /
// get_current_profile / set_profile) call reload() so that profiles added or
// removed by `argocd login` / `argocd context` while the server is running are
// picked up without a restart. Everything else reads the cached registry via
// get(), so the hot path (resolving a client per tool call) does no file I/O.
export type ProfileRegistrySource = {
  get: () => TokenRegistry;
  reload: () => TokenRegistry;
};

// Build a ProfileRegistrySource from the Argo CD CLI config at `configPath`.
// When no path is given the source is a fixed empty registry. When a path is
// given the initial load is eager so a missing or malformed file fails closed
// at startup; a later reload() that fails (e.g. a partial write) is tolerated —
// the last good registry is kept and a warning is logged.
export const argoCdRegistrySource = (
  configPath: string | undefined = process.env.ARGOCD_CONFIG
): ProfileRegistrySource => {
  const path = configPath?.trim();
  if (!path) {
    const empty = new TokenRegistry();
    return { get: () => empty, reload: () => empty };
  }

  // Eager initial load — fail closed at startup, matching the previous behaviour.
  let cached = loadRegistryFromFile(path);
  logger.info(`Loaded ${pluralProfiles(cached.listProfiles().length)} from "${path}"`);

  return {
    get: () => cached,
    reload: () => {
      try {
        cached = loadRegistryFromFile(path);
      } catch (error) {
        logger.warn(
          `Failed to reload Argo CD config from "${path}", keeping previously loaded profiles: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return cached;
    }
  };
};
