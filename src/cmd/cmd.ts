import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  connectStdioTransport,
  connectHttpTransport,
  connectSSETransport
} from '../server/transport.js';

const readPackageVersion = (): string => {
  const entrypoint = process.argv[1] ? fs.realpathSync(process.argv[1]) : process.cwd();
  let dir = path.dirname(path.resolve(entrypoint));
  for (let i = 0; i < 5; i++) {
    const packagePath = path.join(dir, 'package.json');
    if (fs.existsSync(packagePath)) {
      const packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
      if (typeof packageJSON.version === 'string') return packageJSON.version;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return 'unknown';
};

export const cmd = () => {
  const exe = yargs(hideBin(process.argv)).scriptName('argocd-mcp').version(readPackageVersion());

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
      return yargs
        .option('port', {
          type: 'number',
          default: 3000
        })
        .option('stateless', {
          type: 'boolean',
          default: false,
          description: 'Run in stateless mode'
        });
    },
    ({ port, stateless }) => connectHttpTransport(port, stateless)
  );

  exe.demandCommand().parseSync();
};
