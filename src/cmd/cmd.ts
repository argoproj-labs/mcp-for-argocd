import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  connectStdioTransport,
  connectHttpTransport,
  connectSSETransport
} from '../server/transport.js';

export const cmd = () => {
  const exe = yargs(hideBin(process.argv));

  exe.command(
    'stdio',
    'Start ArgoCD MCP server using stdio.',
    () => {},
    () => connectStdioTransport()
  );

  exe.command(
    'sse',
    'Start ArgoCD MCP server using SSE.',
    (yargs) => {
      return yargs
        .option('port', {
          type: 'number',
          default: 3000
        })
        .option('host', {
          type: 'string',
          default: process.env.LISTEN_HOST ?? '',
          description:
            'Host/interface to bind to, e.g. 127.0.0.1 (env: LISTEN_HOST; default: all interfaces)'
        });
    },
    ({ port, host }) => {
      connectSSETransport(port, host || undefined);
    }
  );

  exe.command(
    'http',
    'Start ArgoCD MCP server using Http Stream.',
    (yargs) => {
      return yargs
        .option('port', {
          type: 'number',
          default: 3000
        })
        .option('stateless', {
          type: 'boolean',
          default: false,
          description: 'Run in stateless mode'
        })
        .option('host', {
          type: 'string',
          default: process.env.LISTEN_HOST ?? '',
          description:
            'Host/interface to bind to, e.g. 127.0.0.1 (env: LISTEN_HOST; default: all interfaces)'
        });
    },
    ({ port, stateless, host }) => {
      connectHttpTransport(port, stateless, host || undefined);
    }
  );

  exe.demandCommand().parseSync();
};
