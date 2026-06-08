import { readFileSync } from 'node:fs';
import { logger } from '../logging/logging.js';

// A read-only registry that maps an ArgoCD base URL to the API token that
// should be used for it. It lets a single server target multiple ArgoCD
// instances — each with its own token — without the token ever being passed in
// a tool-call payload: the caller supplies only the (non-secret) base URL and
// the server pairs it with the configured token.
//
// Configuration source: a JSON file whose path is given by the
// ARGOCD_TOKEN_REGISTRY_PATH environment variable. The tokens are secrets, so
// they are read from a file (e.g. a mounted Kubernetes secret) rather than an
// env var, keeping them out of the process environment, crash dumps, and child
// process inheritance. The file contains a JSON array of { baseUrl, token }
// entries, e.g.
//
//   [
//     {"baseUrl":"https://argo-a.example.com","token":"<token-a>"},
//     {"baseUrl":"https://argo-b.example.com","token":"<token-b>"}
//   ]
//
// Base URLs are normalized (lowercased host, trailing slashes stripped) so
// trivial formatting differences between the configured value and the requested
// value don't cause a lookup miss.
export type TokenRegistryEntry = {
  baseUrl: string;
  token: string;
};

export class TokenRegistry {
  private tokensByBaseUrl = new Map<string, string>();

  constructor(entries: TokenRegistryEntry[] = []) {
    for (const entry of entries) {
      if (!entry.baseUrl || !entry.token) {
        // Fail closed: a missing baseUrl/token is a misconfigured credential,
        // not something to silently skip. Don't include the token in the error.
        throw new Error('ArgoCD token registry entry is missing baseUrl or token');
      }
      this.tokensByBaseUrl.set(TokenRegistry.normalize(entry.baseUrl), entry.token);
    }
  }

  // Returns the configured token for the given base URL, or undefined when the
  // base URL is not registered.
  public getToken(baseUrl: string): string | undefined {
    if (!baseUrl) return undefined;
    return this.tokensByBaseUrl.get(TokenRegistry.normalize(baseUrl));
  }

  public getSize(): number {
    return this.tokensByBaseUrl.size;
  }

  // Normalize a base URL for stable lookups: lowercase the scheme+host and drop
  // any trailing slashes. Falls back to a trimmed, de-slashed string when the
  // value is not a parseable URL. Public so callers can compare base URLs
  // against the registry using the exact same normalization the lookup uses.
  public static normalize(baseUrl: string): string {
    const trimmed = baseUrl.trim();
    try {
      const url = new URL(trimmed);
      const origin = url.origin.toLowerCase();
      const path = url.pathname.replace(/\/+$/, '');
      return `${origin}${path}`;
    } catch {
      return trimmed.replace(/\/+$/, '');
    }
  }
}

// Parse the raw JSON contents of a token registry file into a TokenRegistry.
// Throws when the contents are not valid JSON or not a JSON array: an operator
// who configured a registry file expects token routing, so a malformed file is
// a misconfiguration we surface loudly rather than silently degrade.
export const parseTokenRegistry = (raw: string): TokenRegistry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `ArgoCD token registry file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('ArgoCD token registry file must contain a JSON array');
  }
  return new TokenRegistry(parsed as TokenRegistryEntry[]);
};

// Build a TokenRegistry from the JSON file at ARGOCD_TOKEN_REGISTRY_PATH.
// Returns an empty registry when the variable is unset (the server then runs on
// its single default credential). When the variable IS set, this fails closed:
// if the file cannot be read or is malformed it throws, so the process crashes
// at startup rather than silently falling back to the default credential — which
// could route calls to an instance with the wrong token.
export const tokenRegistryFromEnv = (
  registryPath: string | undefined = process.env.ARGOCD_TOKEN_REGISTRY_PATH
): TokenRegistry => {
  if (!registryPath || !registryPath.trim()) {
    return new TokenRegistry();
  }
  let raw: string;
  try {
    raw = readFileSync(registryPath.trim(), 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read ArgoCD token registry file at "${registryPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const registry = parseTokenRegistry(raw);
  logger.info(
    `Loaded ArgoCD token registry from "${registryPath}" with ${registry.getSize()} entr${
      registry.getSize() === 1 ? 'y' : 'ies'
    }`
  );
  return registry;
};
