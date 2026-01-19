# Multi-ArgoCD Console Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the MCP server to manage multiple ArgoCD consoles simultaneously, allowing users to specify which ArgoCD instance each tool operation targets.

**Architecture:**
- Introduce a configuration-based system for defining multiple ArgoCD instances with unique identifiers
- Modify the Server class to maintain a registry of ArgoCDClient instances indexed by instance ID
- Add an optional `argocdInstanceId` parameter to all tools (defaults to primary instance for backward compatibility)
- Support both environment variable configuration (single instance) and JSON configuration file (multiple instances)

**Tech Stack:** TypeScript, Zod for schema validation, existing MCP SDK patterns

---

## Task 1: Create ArgoCD Instance Configuration Schema

**Files:**
- Create: `src/config/argocd-instance.ts`
- Test: `src/config/argocd-instance.test.ts` (optional for this PR)

**Step 1: Define the configuration schema**

Create the configuration types and Zod schemas for ArgoCD instances:

```typescript
import { z } from 'zod';

/**
 * Schema for a single ArgoCD instance configuration
 */
export const ArgoCDInstanceConfigSchema = z.object({
  id: z.string().min(1).describe('Unique identifier for this ArgoCD instance'),
  baseUrl: z.string().url().describe('Base URL of the ArgoCD API'),
  apiToken: z.string().min(1).describe('API token for authentication'),
  description: z.string().optional().describe('Optional description of this instance')
});

export type ArgoCDInstanceConfig = z.infer<typeof ArgoCDInstanceConfigSchema>;

/**
 * Schema for multiple ArgoCD instances configuration
 */
export const ArgoCDConfigSchema = z.object({
  instances: z.array(ArgoCDInstanceConfigSchema).min(1),
  defaultInstanceId: z.string().optional().describe('Default instance ID to use when not specified')
});

export type ArgoCDConfig = z.infer<typeof ArgoCDConfigSchema>;

/**
 * Parse ArgoCD configuration from environment variables or config object
 */
export function parseArgoCDConfig(
  envBaseUrl?: string,
  envApiToken?: string,
  configJson?: string
): ArgoCDConfig {
  // If configJson is provided, parse and validate it
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      return ArgoCDConfigSchema.parse(parsed);
    } catch (error) {
      throw new Error(
        `Failed to parse ArgoCD configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Otherwise, create single instance from environment variables
  if (!envBaseUrl || !envApiToken) {
    throw new Error('ARGOCD_BASE_URL and ARGOCD_API_TOKEN must be provided');
  }

  return {
    instances: [
      {
        id: 'default',
        baseUrl: envBaseUrl,
        apiToken: envApiToken,
        description: 'Default ArgoCD instance from environment variables'
      }
    ],
    defaultInstanceId: 'default'
  };
}
```

**Step 2: Export from config module**

Create barrel export file:

```typescript
// src/config/index.ts
export * from './argocd-instance.js';
```

**Step 3: Commit**

```bash
git add src/config/argocd-instance.ts src/config/index.ts
git commit -m "feat: add ArgoCD instance configuration schema

- Define ArgoCDInstanceConfigSchema for single instance
- Define ArgoCDConfigSchema for multiple instances
- Add parseArgoCDConfig helper for env var fallback
- Support both JSON config and environment variables"
```

---

## Task 2: Modify Server to Support Multiple ArgoCD Clients

**Files:**
- Modify: `src/server/server.ts:13-26` (constructor and initialization)
- Modify: `src/server/server.ts:18-19` (add client registry)

**Step 1: Update Server class to maintain client registry**

Modify the Server class to support multiple clients:

```typescript
// At the top of server.ts, add import
import { ArgoCDConfig } from '../config/index.js';

// Update ServerInfo type
type ServerInfo = {
  argocdConfig: ArgoCDConfig;
};

// Modify the Server class
export class Server extends McpServer {
  private argocdClients: Map<string, ArgoCDClient>;
  private defaultInstanceId: string;

  constructor(serverInfo: ServerInfo) {
    super({
      name: packageJSON.name,
      version: packageJSON.version
    });

    // Initialize client registry
    this.argocdClients = new Map();
    this.defaultInstanceId = serverInfo.argocdConfig.defaultInstanceId ||
                             serverInfo.argocdConfig.instances[0].id;

    // Create a client for each configured instance
    for (const instance of serverInfo.argocdConfig.instances) {
      this.argocdClients.set(
        instance.id,
        new ArgoCDClient(instance.baseUrl, instance.apiToken)
      );
    }

    // Rest of constructor remains the same...
    const isReadOnly = /* ... */;
  }

  /**
   * Get ArgoCD client by instance ID, falling back to default
   */
  private getClient(instanceId?: string): ArgoCDClient {
    const targetId = instanceId || this.defaultInstanceId;
    const client = this.argocdClients.get(targetId);

    if (!client) {
      throw new Error(
        `ArgoCD instance '${targetId}' not found. Available instances: ${Array.from(this.argocdClients.keys()).join(', ')}`
      );
    }

    return client;
  }

  // Add helper to list available instances
  private listInstances(): Array<{ id: string; description?: string }> {
    const result: Array<{ id: string; description?: string }> = [];
    for (const [id] of this.argocdClients) {
      result.push({ id });
    }
    return result;
  }
}
```

**Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: add multi-client registry to Server class

- Replace single argocdClient with Map<string, ArgoCDClient>
- Add getClient() helper to retrieve client by instance ID
- Add listInstances() helper for introspection
- Support defaultInstanceId fallback"
```

---

## Task 3: Add Instance ID Parameter to Read-Only Tools

**Files:**
- Modify: `src/server/server.ts:34-239` (all read-only tool definitions)

**Step 1: Update list_applications tool**

Add `argocdInstanceId` parameter:

```typescript
this.addJsonOutputTool(
  'list_applications',
  'list_applications returns list of applications. Use the filter parameters to narrow down results.',
  {
    argocdInstanceId: z
      .string()
      .optional()
      .describe(
        'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Filter by application name. Supports glob patterns (e.g., "my-app-*"). Optional.'
      ),
    // ... rest of parameters
  },
  async ({ argocdInstanceId, name, project, repo, selector, appNamespace, limit, offset }) => {
    const client = this.getClient(argocdInstanceId);
    return await client.listApplications({
      name,
      project,
      repo,
      selector,
      appNamespace,
      limit,
      offset
    });
  }
);
```

**Step 2: Update get_application tool**

```typescript
this.addJsonOutputTool(
  'get_application',
  'get_application returns application by application name. Optionally specify the application namespace to get applications from non-default namespaces. Use refresh parameter to force ArgoCD to refresh the application state from the source repository.',
  {
    argocdInstanceId: z
      .string()
      .optional()
      .describe(
        'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
      ),
    applicationName: z.string(),
    applicationNamespace: ApplicationNamespaceSchema.optional(),
    refresh: z
      .enum(['normal', 'hard'])
      .optional()
      .describe(
        'Refresh the application state. "normal" refreshes from cache, "hard" forces a refresh from the git repository.'
      )
  },
  async ({ argocdInstanceId, applicationName, applicationNamespace, refresh }) => {
    const client = this.getClient(argocdInstanceId);
    const options: { appNamespace?: string; refresh?: 'normal' | 'hard' } = {};
    if (applicationNamespace) options.appNamespace = applicationNamespace;
    if (refresh) options.refresh = refresh;
    return await client.getApplication(
      applicationName,
      Object.keys(options).length > 0 ? options : undefined
    );
  }
);
```

**Step 3: Update remaining read-only tools**

Apply the same pattern to all remaining read-only tools:
- `get_application_resource_tree`
- `get_application_managed_resources`
- `get_application_workload_logs`
- `get_application_events`
- `get_resource_events`
- `get_resources`
- `get_resource_actions`

Each tool should:
1. Add `argocdInstanceId` as the FIRST parameter in the schema
2. Add the same description
3. Call `this.getClient(argocdInstanceId)` to get the appropriate client
4. Use that client for the operation

**Step 4: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: add argocdInstanceId parameter to read-only tools

- Add argocdInstanceId as optional first parameter to all read tools
- Update tool implementations to use getClient(instanceId)
- Maintain backward compatibility with default instance
- Tools: list/get applications, resources, events, logs, actions"
```

---

## Task 4: Add Instance ID Parameter to Write Tools

**Files:**
- Modify: `src/server/server.ts:242-346` (all write tool definitions)

**Step 1: Update create_application tool**

```typescript
this.addJsonOutputTool(
  'create_application',
  'create_application creates a new ArgoCD application in the specified namespace. The application.metadata.namespace field determines where the Application resource will be created (e.g., "argocd", "argocd-apps", or any custom namespace).',
  {
    argocdInstanceId: z
      .string()
      .optional()
      .describe(
        'ID of the ArgoCD instance to create the application in. If not specified, uses the default instance.'
      ),
    application: ApplicationSchema
  },
  async ({ argocdInstanceId, application }) => {
    const client = this.getClient(argocdInstanceId);
    return await client.createApplication(application as V1alpha1Application);
  }
);
```

**Step 2: Update remaining write tools**

Apply the same pattern to:
- `update_application`
- `delete_application`
- `sync_application`
- `run_resource_action`

**Step 3: Commit**

```bash
git add src/server/server.ts
git commit -m "feat: add argocdInstanceId parameter to write tools

- Add argocdInstanceId as optional first parameter to write tools
- Update implementations to use getClient(instanceId)
- Maintain backward compatibility with default instance
- Tools: create/update/delete/sync applications, run actions"
```

---

## Task 5: Update Server Factory Function

**Files:**
- Modify: `src/server/server.ts:373-375` (createServer function)

**Step 1: Update createServer to accept ArgoCDConfig**

```typescript
export const createServer = (serverInfo: ServerInfo) => {
  return new Server(serverInfo);
};
```

The ServerInfo type was already updated in Task 2, so this should now work correctly.

**Step 2: Commit**

```bash
git add src/server/server.ts
git commit -m "refactor: update createServer to use new ServerInfo type

- ServerInfo now requires ArgoCDConfig instead of individual fields
- No functional changes, just type alignment"
```

---

## Task 6: Update Transport Layer for Configuration

**Files:**
- Modify: `src/server/transport.ts:10-18` (connectStdioTransport)
- Modify: `src/server/transport.ts:20-50` (connectSSETransport)
- Modify: `src/server/transport.ts:52-129` (connectHttpTransport)

**Step 1: Update connectStdioTransport**

```typescript
import { parseArgoCDConfig } from '../config/index.js';

export const connectStdioTransport = () => {
  const configJson = process.env.ARGOCD_CONFIG_JSON;
  const argocdConfig = parseArgoCDConfig(
    process.env.ARGOCD_BASE_URL,
    process.env.ARGOCD_API_TOKEN,
    configJson
  );

  const server = createServer({ argocdConfig });

  logger.info('Connecting to stdio transport');
  logger.info(`Configured ArgoCD instances: ${argocdConfig.instances.map(i => i.id).join(', ')}`);
  server.connect(new StdioServerTransport());
};
```

**Step 2: Update connectSSETransport**

```typescript
export const connectSSETransport = (port: number) => {
  const app = express();
  const transports: { [sessionId: string]: SSEServerTransport } = {};

  app.get('/sse', async (req, res) => {
    const configJson = req.headers['x-argocd-config-json'] as string | undefined;
    const argocdConfig = parseArgoCDConfig(
      req.headers['x-argocd-base-url'] as string,
      req.headers['x-argocd-api-token'] as string,
      configJson
    );

    const server = createServer({ argocdConfig });

    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on('close', () => {
      delete transports[transport.sessionId];
    });
    await server.connect(transport);
  });

  // ... rest remains the same
};
```

**Step 3: Update connectHttpTransport**

```typescript
export const connectHttpTransport = (port: number) => {
  const app = express();
  app.use(express.json());

  const httpTransports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  app.post('/mcp', async (req, res) => {
    const sessionIdFromHeader = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionIdFromHeader && httpTransports[sessionIdFromHeader]) {
      transport = httpTransports[sessionIdFromHeader];
    } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
      const configJson = req.headers['x-argocd-config-json'] as string | undefined;
      const argocdBaseUrl =
        (req.headers['x-argocd-base-url'] as string) || process.env.ARGOCD_BASE_URL;
      const argocdApiToken =
        (req.headers['x-argocd-api-token'] as string) || process.env.ARGOCD_API_TOKEN;

      let argocdConfig: ArgoCDConfig;
      try {
        argocdConfig = parseArgoCDConfig(argocdBaseUrl, argocdApiToken, configJson);
      } catch (error) {
        res
          .status(400)
          .send(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          httpTransports[newSessionId] = transport;
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete httpTransports[transport.sessionId];
        }
      };

      const server = createServer({ argocdConfig });

      await server.connect(transport);
    } else {
      // ... error handling remains the same
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ... rest remains the same
};
```

**Step 4: Commit**

```bash
git add src/server/transport.ts
git commit -m "feat: update transport layer for multi-instance config

- Use parseArgoCDConfig in all transport modes
- Support ARGOCD_CONFIG_JSON env var for stdio transport
- Support x-argocd-config-json header for SSE/HTTP transports
- Add logging for configured instances in stdio mode
- Maintain backward compatibility with single instance"
```

---

## Task 7: Update Documentation

**Files:**
- Modify: `README.md:1-196`

**Step 1: Add multi-instance configuration section**

Add a new section after "Read Only Mode":

```markdown
### Multiple ArgoCD Instances

The MCP server supports managing multiple ArgoCD instances simultaneously. You can configure multiple instances in two ways:

#### Option 1: Environment Variable (Recommended)

Set the `ARGOCD_CONFIG_JSON` environment variable with a JSON configuration:

```json
{
  "instances": [
    {
      "id": "prod",
      "baseUrl": "https://argocd-prod.example.com",
      "apiToken": "prod-token",
      "description": "Production ArgoCD"
    },
    {
      "id": "staging",
      "baseUrl": "https://argocd-staging.example.com",
      "apiToken": "staging-token",
      "description": "Staging ArgoCD"
    }
  ],
  "defaultInstanceId": "prod"
}
```

#### Option 2: HTTP Header (SSE/HTTP transports only)

Pass the configuration as `x-argocd-config-json` header when connecting.

#### Using Instance IDs in Tool Calls

When multiple instances are configured, you can specify which instance to use via the `argocdInstanceId` parameter in any tool call:

```typescript
// List applications from production ArgoCD
await client.call('list_applications', {
  argocdInstanceId: 'prod'
});

// Get application from staging ArgoCD
await client.call('get_application', {
  argocdInstanceId: 'staging',
  applicationName: 'my-app'
});
```

If `argocdInstanceId` is not specified, the default instance will be used.

#### Backward Compatibility

The server maintains full backward compatibility. If you don't provide `ARGOCD_CONFIG_JSON`, the server will use `ARGOCD_BASE_URL` and `ARGOCD_API_TOKEN` environment variables to create a single default instance.
```

**Step 2: Update configuration examples**

Update the Cursor example:

```json
{
  "mcpServers": {
    "argocd-mcp": {
      "command": "npx",
      "args": [
        "argocd-mcp@latest",
        "stdio"
      ],
      "env": {
        "ARGOCD_CONFIG_JSON": "{\"instances\":[{\"id\":\"default\",\"baseUrl\":\"<argocd_url>\",\"apiToken\":\"<argocd_token>\"}],\"defaultInstanceId\":\"default\"}"
      }
    }
  }
}
```

Or keep it simple for single instance:

```json
{
  "mcpServers": {
    "argocd-mcp": {
      "command": "npx",
      "args": [
        "argocd-mcp@latest",
        "stdio"
      ],
      "env": {
        "ARGOCD_BASE_URL": "<argocd_url>",
        "ARGOCD_API_TOKEN": "<argocd_token>"
      }
    }
  }
}
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add multi-instance configuration documentation

- Document ARGOCD_CONFIG_JSON environment variable
- Explain instance ID usage in tool calls
- Add configuration examples for multiple instances
- Clarify backward compatibility with single instance
- Update configuration examples for various clients"
```

---

## Task 8: Add list_instances Tool (Optional Enhancement)

**Files:**
- Modify: `src/server/server.ts:34` (after other tool registrations)

**Step 1: Add list_instances tool**

Add a new tool to list available ArgoCD instances:

```typescript
// Add after all other tool registrations, before the read-only check
this.addJsonOutputTool(
  'list_argocd_instances',
  'list_argocd_instances returns all configured ArgoCD instances that can be targeted with the argocdInstanceId parameter.',
  {},
  async () => {
    return {
      instances: Array.from(this.argocdClients.keys()).map(id => ({ id })),
      defaultInstanceId: this.defaultInstanceId
    };
  }
);
```

**Step 2: Update README with new tool**

Add to Available Tools section:

```markdown
### Instance Management
- `list_argocd_instances`: List all configured ArgoCD instances and the default instance ID
```

**Step 3: Commit**

```bash
git add src/server/server.ts README.md
git commit -m "feat: add list_argocd_instances tool

- New tool to discover available ArgoCD instances
- Returns instance IDs and default instance
- Helps users understand which instances are available
- Update documentation with new tool"
```

---

## Task 9: Add Integration Tests

**Files:**
- Create: `tests/multi-instance.test.ts`

**Step 1: Write integration test**

```typescript
import { describe, it, expect } from 'vitest';
import { parseArgoCDConfig } from '../src/config/index.js';
import { createServer } from '../src/server/server.js';

describe('Multi-instance ArgoCD support', () => {
  it('should parse single instance from environment variables', () => {
    const config = parseArgoCDConfig(
      'https://argocd.example.com',
      'test-token'
    );

    expect(config.instances).toHaveLength(1);
    expect(config.instances[0].id).toBe('default');
    expect(config.instances[0].baseUrl).toBe('https://argocd.example.com');
    expect(config.defaultInstanceId).toBe('default');
  });

  it('should parse multiple instances from JSON', () => {
    const configJson = JSON.stringify({
      instances: [
        { id: 'prod', baseUrl: 'https://prod.example.com', apiToken: 'prod-token' },
        { id: 'staging', baseUrl: 'https://staging.example.com', apiToken: 'staging-token' }
      ],
      defaultInstanceId: 'prod'
    });

    const config = parseArgoCDConfig(undefined, undefined, configJson);

    expect(config.instances).toHaveLength(2);
    expect(config.instances[0].id).toBe('prod');
    expect(config.instances[1].id).toBe('staging');
    expect(config.defaultInstanceId).toBe('prod');
  });

  it('should throw error when no configuration provided', () => {
    expect(() => parseArgoCDConfig()).toThrow();
  });

  it('should create server with multiple instances', () => {
    const config = parseArgoCDConfig(
      undefined,
      undefined,
      JSON.stringify({
        instances: [
          { id: 'test1', baseUrl: 'https://test1.com', apiToken: 'token1' },
          { id: 'test2', baseUrl: 'https://test2.com', apiToken: 'token2' }
        ]
      })
    );

    const server = createServer({ argocdConfig: config });
    expect(server).toBeDefined();
  });
});
```

**Step 2: Run tests**

```bash
pnpm test
```

Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/multi-instance.test.ts
git commit -m "test: add integration tests for multi-instance support

- Test single instance from env vars
- Test multiple instances from JSON config
- Test error handling for missing config
- Test server creation with multiple instances"
```

---

## Task 10: Update Type Definitions

**Files:**
- Modify: `src/shared/models/schema.ts` (if exists, to add instance ID schema)

**Step 1: Add reusable schema for instance ID**

If there's a shared schema file, add:

```typescript
export const ArgoCDInstanceIdSchema = z
  .string()
  .optional()
  .describe(
    'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
  );
```

**Step 2: Update tool schemas to use shared schema**

Refactor tool definitions to use the shared schema:

```typescript
import { ArgoCDInstanceIdSchema } from '../shared/models/schema.js';

// In tool definitions:
{
  argocdInstanceId: ArgoCDInstanceIdSchema,
  // ... other parameters
}
```

**Step 3: Commit**

```bash
git add src/shared/models/schema.ts src/server/server.ts
git commit -m "refactor: extract instance ID schema to shared module

- Create ArgoCDInstanceIdSchema for reuse
- DRY: Single source of truth for instance ID parameter
- Update all tool definitions to use shared schema"
```

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-01-19-multi-argocd-support.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
