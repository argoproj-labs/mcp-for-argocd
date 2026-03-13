import { AsyncLocalStorage } from 'node:async_hooks';

export type ServerInfo = {
  argocdBaseUrl: string;
  argocdApiToken: string;
};

const requestServerInfo = new AsyncLocalStorage<ServerInfo>();

export const runWithServerInfo = <T>(serverInfo: ServerInfo, callback: () => T) =>
  requestServerInfo.run(serverInfo, callback);

export const getCurrentServerInfo = (): ServerInfo => {
  const serverInfo = requestServerInfo.getStore();
  const argocdBaseUrl = serverInfo?.argocdBaseUrl || process.env.ARGOCD_BASE_URL || '';
  const argocdApiToken = serverInfo?.argocdApiToken || process.env.ARGOCD_API_TOKEN || '';

  if (argocdBaseUrl === '' || argocdApiToken === '') {
    throw new Error(
      'x-argocd-base-url and x-argocd-api-token must be provided in headers or environment.'
    );
  }

  return {
    argocdBaseUrl,
    argocdApiToken
  };
};
