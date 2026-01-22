import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OIDCConfig, StoredAuth, TokenInfo } from './types.js';

interface TokenStoreData {
  version: number;
  servers: { [serverUrl: string]: StoredAuth };
}

/**
 * Get the configuration directory path
 * Uses XDG_CONFIG_HOME if set, otherwise ~/.argocd-mcp
 */
function getConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, 'argocd-mcp');
  }
  return join(homedir(), '.argocd-mcp');
}

/**
 * Get the auth file path
 */
function getAuthFilePath(): string {
  return join(getConfigDir(), 'auth.json');
}

/**
 * Normalize server URL for consistent storage keys
 */
function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  // Remove trailing slash and use lowercase
  return url.origin.toLowerCase();
}

/**
 * Read the token store from disk
 */
async function readStore(): Promise<TokenStoreData> {
  try {
    const content = await readFile(getAuthFilePath(), 'utf-8');
    return JSON.parse(content) as TokenStoreData;
  } catch (err) {
    // File doesn't exist or is invalid, return empty store
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, servers: {} };
    }
    throw err;
  }
}

/**
 * Write the token store to disk with secure permissions
 */
async function writeStore(store: TokenStoreData): Promise<void> {
  const configDir = getConfigDir();
  const authFile = getAuthFilePath();

  // Ensure config directory exists
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  // Write the file
  await writeFile(authFile, JSON.stringify(store, null, 2), 'utf-8');

  // Set secure file permissions (owner read/write only)
  await chmod(authFile, 0o600);
}

/**
 * Save authentication token for a server
 */
export async function saveToken(
  serverUrl: string,
  token: TokenInfo,
  oidcConfig: OIDCConfig
): Promise<void> {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const store = await readStore();

  store.servers[normalizedUrl] = {
    serverUrl: normalizedUrl,
    token,
    oidcConfig,
    storedAt: Date.now()
  };

  await writeStore(store);
}

/**
 * Load authentication token for a server
 */
export async function loadToken(serverUrl: string): Promise<StoredAuth | null> {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const store = await readStore();

  return store.servers[normalizedUrl] || null;
}

/**
 * Delete authentication token for a server
 */
export async function deleteToken(serverUrl: string): Promise<boolean> {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const store = await readStore();

  if (store.servers[normalizedUrl]) {
    delete store.servers[normalizedUrl];
    await writeStore(store);
    return true;
  }

  return false;
}

/**
 * List all stored server URLs
 */
export async function listServers(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store.servers);
}

/**
 * Get the first stored server (useful for default behavior)
 */
export async function getDefaultServer(): Promise<StoredAuth | null> {
  const store = await readStore();
  const servers = Object.values(store.servers);
  return servers.length > 0 ? servers[0] : null;
}

/**
 * Clear all stored tokens
 */
export async function clearAllTokens(): Promise<void> {
  try {
    await unlink(getAuthFilePath());
  } catch (err) {
    // Ignore if file doesn't exist
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Check if a token is expired or about to expire
 * @param token The token to check
 * @param bufferMs Buffer time in milliseconds before actual expiry (default: 5 minutes)
 */
export function isTokenExpired(token: TokenInfo, bufferMs: number = 5 * 60 * 1000): boolean {
  if (!token.expiresAt) {
    // No expiry info, assume not expired
    return false;
  }
  return Date.now() + bufferMs >= token.expiresAt;
}
