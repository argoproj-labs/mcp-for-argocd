import { readFileSync, writeFileSync, renameSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { load, dump } from 'js-yaml';

const getConfigPath = () =>
  process.env.ARGOCD_CONFIG_HOME
    ? join(process.env.ARGOCD_CONFIG_HOME, 'config')
    : join(homedir(), '.config', 'argocd', 'config');

type ArgocdConfigFile = {
  contexts?: Array<{ name: string; server: string; user?: string }>;
  users?: Array<{ name: string; 'auth-token'?: string; 'refresh-token'?: string }>;
  servers?: Array<{ server: string; [key: string]: unknown }>;
  'current-context'?: string;
};

export type ArgocdContextInfo = {
  server: string;
  baseUrl: string;
  authToken: string;
  refreshToken: string | undefined;
};

const readConfig = (): ArgocdConfigFile => {
  const raw = readFileSync(getConfigPath(), 'utf8');
  return (load(raw) as ArgocdConfigFile) ?? {};
};

export const getContextInfo = (contextName: string): ArgocdContextInfo => {
  const config = readConfig();

  const ctx = (config.contexts ?? []).find((c) => c.name === contextName);
  if (!ctx) {
    const available = (config.contexts ?? []).map((c) => c.name);
    throw new Error(
      `ArgoCD context "${contextName}" not found in ${getConfigPath()}. Available: ${available.join(', ')}`
    );
  }

  const userName = ctx.user ?? ctx.server;
  const user = (config.users ?? []).find((u) => u.name === userName);
  if (!user?.['auth-token']) {
    throw new Error(`No auth-token found for context "${contextName}" in ${getConfigPath()}`);
  }

  return {
    server: ctx.server,
    baseUrl: `https://${ctx.server}`,
    authToken: user['auth-token'],
    refreshToken: user['refresh-token']
  };
};

export const updateTokensInConfig = (
  contextName: string,
  newAuthToken: string,
  newRefreshToken?: string
): void => {
  const config = readConfig();

  const ctx = (config.contexts ?? []).find((c) => c.name === contextName);
  const userName = ctx?.user ?? ctx?.server;
  const user = (config.users ?? []).find((u) => u.name === userName);

  if (!user) {
    throw new Error(`Cannot update tokens: user entry not found for context "${contextName}"`);
  }

  user['auth-token'] = newAuthToken;
  if (newRefreshToken) {
    user['refresh-token'] = newRefreshToken;
  }

  const configPath = getConfigPath();
  const tmp = `${configPath}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // renameSync подменяет inode целиком, поэтому режим целевого файла НЕ наследуется —
    // без этого конфиг получал 0666 & ~umask (обычно 0644) и argocd CLI ругался на
    // слишком открытые права. Сохраняем режим существующего файла, по умолчанию 0600.
    let mode = 0o600;
    try {
      mode = statSync(configPath).mode & 0o777;
    } catch {
      /* нового файла ещё нет */
    }
    writeFileSync(tmp, dump(config), { encoding: 'utf8', mode });
    chmodSync(tmp, mode); // writeFileSync пропускает mode через umask, chmod — нет
    renameSync(tmp, configPath);
  } catch (err) {
    try { renameSync(tmp, `${tmp}.failed`); } catch { /* ignore */ }
    throw err;
  }
};
