import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  connectStdioTransport,
  connectHttpTransport,
  connectSSETransport
} from '../server/transport.js';
import { performSSOLogin } from '../auth/sso-login.js';
import { deleteToken, listServers, loadToken } from '../auth/token-store.js';
import { SSONotConfiguredError } from '../auth/settings.js';

export const cmd = () => {
  const exe = yargs(hideBin(process.argv));

  exe.command(
    'stdio',
    'Start ArgoCD MCP server using stdio.',
    () => {},
    async () => connectStdioTransport()
  );

  exe.command(
    'sse',
    'Start ArgoCD MCP server using SSE.',
    (yargs) => {
      return yargs.option('port', {
        type: 'number',
        default: 3000
      });
    },
    ({ port }) => connectSSETransport(port)
  );

  exe.command(
    'http',
    'Start ArgoCD MCP server using Http Stream.',
    (yargs) => {
      return yargs.option('port', {
        type: 'number',
        default: 3000
      });
    },
    ({ port }) => connectHttpTransport(port)
  );

  exe.command(
    'login <server>',
    'Authenticate with an ArgoCD server using SSO.',
    (yargs) => {
      return yargs
        .positional('server', {
          type: 'string',
          describe: 'ArgoCD server URL (e.g., https://argocd.example.com)',
          demandOption: true
        })
        .option('headless', {
          type: 'boolean',
          default: false,
          describe: 'Print the authentication URL instead of opening a browser'
        })
        .option('sso-port', {
          type: 'number',
          default: 8085,
          describe: 'Port for the SSO callback server'
        })
        .option('insecure', {
          type: 'boolean',
          default: false,
          describe: 'Skip TLS certificate verification'
        });
    },
    async ({ server, headless, ssoPort, insecure }) => {
      try {
        await performSSOLogin(server as string, {
          port: ssoPort,
          openBrowser: !headless,
          insecure
        });
        console.log(`Successfully logged in to ${server}`);
      } catch (err) {
        if (err instanceof SSONotConfiguredError) {
          console.error(`Error: ${err.message}`);
          console.error('\nSSO is not configured on this ArgoCD server.');
          console.error(
            'Please use ARGOCD_API_TOKEN environment variable for token-based authentication.'
          );
          process.exit(1);
        }
        console.error(`Login failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }
  );

  exe.command(
    'logout [server]',
    'Remove stored authentication for an ArgoCD server.',
    (yargs) => {
      return yargs.positional('server', {
        type: 'string',
        describe: 'ArgoCD server URL (if not provided, lists all stored servers)'
      });
    },
    async ({ server }) => {
      if (!server) {
        // List all stored servers
        const servers = await listServers();
        if (servers.length === 0) {
          console.log('No stored authentication found.');
        } else {
          console.log('Stored authentication for servers:');
          for (const s of servers) {
            console.log(`  - ${s}`);
          }
          console.log('\nTo logout, run: argocd-mcp logout <server-url>');
        }
        return;
      }

      const deleted = await deleteToken(server);
      if (deleted) {
        console.log(`Successfully logged out from ${server}`);
      } else {
        console.log(`No stored authentication found for ${server}`);
      }
    }
  );

  exe.command(
    'whoami [server]',
    'Show current authentication status.',
    (yargs) => {
      return yargs.positional('server', {
        type: 'string',
        describe: 'ArgoCD server URL (if not provided, shows all stored auth)'
      });
    },
    async ({ server }) => {
      if (server) {
        const auth = await loadToken(server);
        if (auth) {
          console.log(`Authenticated to: ${auth.serverUrl}`);
          console.log(`  OIDC Issuer: ${auth.oidcConfig.issuer}`);
          console.log(`  Stored at: ${new Date(auth.storedAt).toLocaleString()}`);
          if (auth.token.expiresAt) {
            const expiresAt = new Date(auth.token.expiresAt);
            const isExpired = Date.now() >= auth.token.expiresAt;
            console.log(
              `  Token expires: ${expiresAt.toLocaleString()}${isExpired ? ' (EXPIRED)' : ''}`
            );
          }
        } else {
          console.log(`No stored authentication for ${server}`);
        }
      } else {
        const servers = await listServers();
        if (servers.length === 0) {
          console.log('No stored authentication found.');
          console.log('\nTo login, run: argocd-mcp login <server-url>');
        } else {
          console.log('Stored authentication:');
          for (const s of servers) {
            const auth = await loadToken(s);
            if (auth) {
              const status =
                auth.token.expiresAt && Date.now() >= auth.token.expiresAt ? ' (EXPIRED)' : '';
              console.log(`  - ${s}${status}`);
            }
          }
        }
      }
    }
  );

  exe.demandCommand().parse();
};
