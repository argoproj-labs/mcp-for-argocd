import { readFileSync } from 'node:fs';
import { logger } from '../logging/logging.js';
import {
  CommandTokenProvider,
  StaticTokenProvider,
  type TokenProvider
} from '../argocd/tokenProvider.js';

// A read-only registry that maps an ArgoCD base URL to the credential that
// should be used for it. It lets a single server target multiple ArgoCD
// instances — each with its own credential — without the token ever being
// passed in a tool-call payload: the caller supplies only the (non-secret) base
// URL and the server pairs it with the configured credential.
//
// Configuration source: a JSON file whose path is given by the
// ARGOCD_TOKEN_REGISTRY_PATH environment variable. The tokens are secrets, so
// they are read from a file (e.g. a mounted Kubernetes secret) rather than an
// env var, keeping them out of the process environment, crash dumps, and child
// process inheritance. The file contains a JSON array of entries, each with a
// baseUrl and exactly one of:
//
//   token        — a static bearer token, used as-is;
//   tokenCommand — an executable + arguments that print a fresh token to
//                  stdout. Run without a shell, cached for tokenTTLSeconds
//                  and re-run when the cache expires or ArgoCD rejects the
//                  token. This is how short-lived credentials (GCP IAP
//                  identity tokens, SSO sessions, Vault leases, …) are
//                  supported without cloud-specific code in the server.
//
//   [
//     {"baseUrl":"https://argo-a.example.com","token":"<token-a>"},
//     {"baseUrl":"https://argo-b.example.com",
//      "tokenCommand":["gcloud","auth","print-identity-token","--audiences=<client-id>"],
//      "tokenTTLSeconds":2700,"tokenCommandTimeoutSeconds":10}
//   ]
//
// Base URLs are normalized (lowercased host, trailing slashes stripped) so
// trivial formatting differences between the configured value and the requested
// value don't cause a lookup miss.
export type TokenRegistryEntry = {
  baseUrl: string;
  token?: string;
  tokenCommand?: string[];
  tokenTTLSeconds?: number;
  tokenCommandTimeoutSeconds?: number;
};

export class TokenRegistry {
  private providersByBaseUrl = new Map<string, TokenProvider>();

  constructor(entries: TokenRegistryEntry[] = []) {
    for (const entry of entries) {
      // Validate (and build the provider) before touching baseUrl.
      const provider = TokenRegistry.providerFor(entry);
      this.providersByBaseUrl.set(TokenRegistry.normalize(entry.baseUrl), provider);
    }
  }

  // Returns the configured token provider for the given base URL, or undefined
  // when the base URL is not registered. The same instance is returned on every
  // lookup: it owns the token cache for command-backed entries.
  public getProvider(baseUrl: string): TokenProvider | undefined {
    if (!baseUrl) return undefined;
    return this.providersByBaseUrl.get(TokenRegistry.normalize(baseUrl));
  }

  public getSize(): number {
    return this.providersByBaseUrl.size;
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

  // Validate one entry and build its provider. Fails closed: a malformed entry
  // is a misconfigured credential, not something to silently skip. Error
  // messages name the base URL (not secret) but never a token value.
  private static providerFor(entry: TokenRegistryEntry): TokenProvider {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('ArgoCD token registry entry must be an object');
    }
    if (!entry.baseUrl) {
      throw new Error('ArgoCD token registry entry is missing baseUrl');
    }
    const where = `for "${entry.baseUrl}"`;
    const hasToken = Boolean(entry.token);
    const hasCommand = entry.tokenCommand !== undefined;
    if (hasToken === hasCommand) {
      throw new Error(
        `ArgoCD token registry entry ${where} must specify exactly one of "token" or "tokenCommand"`
      );
    }
    if (hasToken) {
      if (entry.tokenTTLSeconds !== undefined || entry.tokenCommandTimeoutSeconds !== undefined) {
        throw new Error(
          `ArgoCD token registry entry ${where}: "tokenTTLSeconds" and "tokenCommandTimeoutSeconds" are only valid with "tokenCommand"`
        );
      }
      return new StaticTokenProvider(entry.token as string);
    }
    try {
      return new CommandTokenProvider({
        command: entry.tokenCommand as string[],
        ttlSeconds: entry.tokenTTLSeconds,
        timeoutSeconds: entry.tokenCommandTimeoutSeconds
      });
    } catch (error) {
      throw new Error(
        `ArgoCD token registry entry ${where}: ${error instanceof Error ? error.message : String(error)}`
      );
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
