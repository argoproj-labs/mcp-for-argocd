// A read-only in-memory registry that maps an ArgoCD base URL to the API token
// that should be used for it, and an optional profile name to that base URL. It
// lets a single server target multiple ArgoCD instances — each with its own
// token — without the token ever being passed in a tool-call payload: the
// caller selects an instance by its (non-secret) profile name or base URL and
// the server pairs it with the configured token.
//
// The registry is populated from the user's Argo CD CLI config file (see
// argocd/localConfig.ts), so the credentials obtained via `argocd login`
// (including SSO/OIDC and LDAP tokens) are reused directly. Tokens stay in this
// in-memory store and are never exposed by the profile tools or tool-call
// payloads.
//
// Base URLs are normalized (lowercased host, trailing slashes stripped) so
// trivial formatting differences between the configured value and the requested
// value don't cause a lookup miss.
//
// An entry may carry a non-secret `name`, which turns it into a selectable
// "profile" (a friendly alias for the base URL — see Profile below), and an
// optional `default: true` marking the profile that is active when a session
// starts. Entries without a name still route by base URL; they just don't
// appear in the profile list.
export type TokenRegistryEntry = {
  baseUrl: string;
  token: string;
  name?: string;
  default?: boolean;
};

// The non-secret projection of a registry entry. A profile is a friendly,
// named alias for a base URL that callers can select without ever seeing — or
// needing to know — the token. The token is deliberately absent here so it can
// never leak through a profile-listing tool's output.
export type Profile = {
  name: string;
  baseUrl: string;
};

export class TokenRegistry {
  private tokensByBaseUrl = new Map<string, string>();
  // Profiles keyed by their normalized (lowercased, trimmed) name. The stored
  // Profile keeps the original-cased name and base URL for display.
  private profilesByName = new Map<string, Profile>();
  private defaultProfileName?: string;

  constructor(entries: TokenRegistryEntry[] = []) {
    for (const entry of entries) {
      if (!entry.baseUrl || !entry.token) {
        // Fail closed: a missing baseUrl/token is a misconfigured credential,
        // not something to silently skip. Don't include the token in the error.
        throw new Error('ArgoCD token registry entry is missing baseUrl or token');
      }
      this.tokensByBaseUrl.set(TokenRegistry.normalize(entry.baseUrl), entry.token);

      const name = entry.name?.trim();
      if (!name) {
        // Unnamed entry: usable for base-URL routing, but not a selectable
        // profile. Skip the profile bookkeeping (including any `default` flag,
        // which is meaningless without a name to select).
        continue;
      }
      const key = TokenRegistry.normalizeName(name);
      if (this.profilesByName.has(key)) {
        // Fail closed: duplicate names make selection ambiguous. Don't leak the
        // token in the error.
        throw new Error(`ArgoCD token registry has duplicate profile name "${name}"`);
      }
      this.profilesByName.set(key, { name, baseUrl: entry.baseUrl });
      if (entry.default) {
        if (this.defaultProfileName) {
          // Fail closed: more than one default is ambiguous.
          throw new Error('ArgoCD token registry has more than one default profile');
        }
        this.defaultProfileName = name;
      }
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

  // Returns the profile with the given name (case-insensitive), or undefined
  // when no such profile is registered.
  public getProfile(name: string): Profile | undefined {
    if (!name) return undefined;
    return this.profilesByName.get(TokenRegistry.normalizeName(name));
  }

  // Returns all configured profiles as non-secret { name, baseUrl } objects.
  // Never includes tokens.
  public listProfiles(): Profile[] {
    return [...this.profilesByName.values()].map((p) => ({ name: p.name, baseUrl: p.baseUrl }));
  }

  // Returns the name of the profile marked `default: true`, or undefined when
  // none is.
  public getDefaultProfileName(): string | undefined {
    return this.defaultProfileName;
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

  // Normalize a profile name for stable, case-insensitive lookups. Mirrors the
  // base-URL normalization spirit so "Staging" and "staging" select the same
  // profile.
  public static normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }
}
