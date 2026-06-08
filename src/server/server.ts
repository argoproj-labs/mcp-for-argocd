import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';

import packageJSON from '../../package.json' with { type: 'json' };
import { ArgoCDClient } from '../argocd/client.js';
import { z, ZodRawShape } from 'zod';
import { V1alpha1Application, V1alpha1ResourceResult } from '../types/argocd-types.js';
import {
  ApplicationNamespaceSchema,
  ApplicationSchema,
  ResourceRefSchema
} from '../shared/models/schema.js';
import { TokenRegistry, tokenRegistryFromEnv } from './tokenRegistry.js';

type ServerInfo = {
  argocdBaseUrl: string;
  argocdApiToken: string;
  // Optional registry mapping additional ArgoCD base URLs to their tokens. When
  // omitted, it is loaded from the ARGOCD_TOKEN_REGISTRY_PATH env var.
  tokenRegistry?: TokenRegistry;
};

// Per-call argument that any tool may accept to target a specific ArgoCD
// instance's base URL. It overrides the session default (resolved at connect
// time from the x-argocd-base-url header or ARGOCD_BASE_URL env var) and is
// optional when a session default exists; otherwise it is required.
//
// The API token is deliberately NOT a tool argument: it is only ever resolved
// from the x-argocd-api-token header / ARGOCD_API_TOKEN env var so the secret
// never enters prompts, model context, or tool-call logs.
const argoCDArgsSchema = {
  argocdBaseUrl: z
    .string()
    .optional()
    .describe(
      'ArgoCD base URL to use for this call (e.g. "https://argocd.example.com"). Overrides the server default. Optional if the server is configured with a default base URL (x-argocd-base-url header or ARGOCD_BASE_URL env var); otherwise required.'
    )
} satisfies ZodRawShape;

type ArgoCDArgs = {
  argocdBaseUrl?: string;
};

export class Server extends McpServer {
  private defaultBaseUrl: string;
  private defaultApiToken: string;
  private tokenRegistry: TokenRegistry;
  private argocdClient: ArgoCDClient;
  // Cache per-credential clients to avoid rebuilding the HttpClient on every
  // call. Keyed by baseUrl + token, since the same base URL may resolve to
  // different tokens (request token vs. registry token vs. default).
  private clientCache = new Map<string, ArgoCDClient>();

  constructor(serverInfo: ServerInfo) {
    super({
      name: packageJSON.name,
      version: packageJSON.version
    });
    this.defaultBaseUrl = serverInfo.argocdBaseUrl;
    this.defaultApiToken = serverInfo.argocdApiToken;
    this.tokenRegistry = serverInfo.tokenRegistry ?? tokenRegistryFromEnv();
    this.argocdClient = new ArgoCDClient(serverInfo.argocdBaseUrl, serverInfo.argocdApiToken);

    const isReadOnly =
      String(process.env.MCP_READ_ONLY ?? '')
        .trim()
        .toLowerCase() === 'true';

    // Always register read/query tools
    this.addJsonOutputTool(
      'list_applications',
      'list_applications returns list of applications',
      {
        search: z
          .string()
          .optional()
          .describe(
            'Search applications by name. This is a partial match on the application name and does not support glob patterns (e.g. "*"). Optional.'
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Maximum number of applications to return. Use this to reduce token usage when there are many applications. Optional.'
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Number of applications to skip before returning results. Use with limit for pagination. Optional.'
          )
      },
      async ({ search, limit, offset }, client) =>
        await client.listApplications({
          search: search ?? undefined,
          limit,
          offset
        })
    );
    this.addJsonOutputTool(
      'list_clusters',
      'list_clusters returns list of clusters registered with ArgoCD',
      {
        server: z.string().optional().describe('Filter clusters by server URL. Optional.'),
        name: z.string().optional().describe('Filter clusters by name. Optional.')
      },
      async ({ server, name }, client) =>
        await client.listClusters({
          server: server ?? undefined,
          name: name ?? undefined
        })
    );
    this.addJsonOutputTool(
      'get_application',
      'get_application returns application by application name. Optionally specify the application namespace to get applications from non-default namespaces.',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema.optional()
      },
      async ({ applicationName, applicationNamespace }, client) =>
        await client.getApplication(applicationName, applicationNamespace)
    );
    this.addJsonOutputTool(
      'get_application_resource_tree',
      'get_application_resource_tree returns resource tree for application by application name. Optionally specify the application namespace to get resource tree from applications in non-default namespaces.',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema.optional().describe(
          'The namespace where the application is located. Required if application is not in the default namespace.'
        )
      },
      async ({ applicationName, applicationNamespace }, client) =>
        await client.getApplicationResourceTree(applicationName, applicationNamespace)
    );
    this.addJsonOutputTool(
      'get_application_managed_resources',
      'get_application_managed_resources returns managed resources for application by application name with optional filtering. Use filters to avoid token limits with large applications. Examples: kind="ConfigMap" for config maps only, namespace="production" for specific namespace, or combine multiple filters.',
      {
        applicationName: z.string(),
        kind: z
          .string()
          .optional()
          .describe(
            'Filter by Kubernetes resource kind (e.g., "ConfigMap", "Secret", "Deployment")'
          ),
        namespace: z.string().optional().describe('Filter by Kubernetes namespace'),
        name: z.string().optional().describe('Filter by resource name'),
        version: z.string().optional().describe('Filter by resource API version'),
        group: z.string().optional().describe('Filter by API group'),
        appNamespace: z.string().optional().describe('Filter by Argo CD application namespace'),
        project: z.string().optional().describe('Filter by Argo CD project')
      },
      async (
        { applicationName, kind, namespace, name, version, group, appNamespace, project },
        client
      ) => {
        const filters = {
          ...(kind && { kind }),
          ...(namespace && { namespace }),
          ...(name && { name }),
          ...(version && { version }),
          ...(group && { group }),
          ...(appNamespace && { appNamespace }),
          ...(project && { project })
        };
        return await client.getApplicationManagedResources(
          applicationName,
          Object.keys(filters).length > 0 ? filters : undefined
        );
      }
    );
    this.addJsonOutputTool(
      'get_application_workload_logs',
      'get_application_workload_logs returns logs for application workload (Deployment, StatefulSet, Pod, etc.) by application name and resource ref and optionally container name',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRef: ResourceRefSchema,
        container: z.string()
      },
      async ({ applicationName, applicationNamespace, resourceRef, container }, client) =>
        await client.getWorkloadLogs(
          applicationName,
          applicationNamespace,
          resourceRef as V1alpha1ResourceResult,
          container
        )
    );
    this.addJsonOutputTool(
      'get_application_events',
      'get_application_events returns events for application by application name. Optionally specify the application namespace to get events from applications in non-default namespaces.',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema.optional().describe(
          'The namespace where the application is located. Required if application is not in the default namespace.'
        )
      },
      async ({ applicationName, applicationNamespace }, client) =>
        await client.getApplicationEvents(applicationName, applicationNamespace)
    );
    this.addJsonOutputTool(
      'get_resource_events',
      'get_resource_events returns events for a resource that is managed by an application',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceUID: z.string(),
        resourceNamespace: z.string(),
        resourceName: z.string()
      },
      async (
        { applicationName, applicationNamespace, resourceUID, resourceNamespace, resourceName },
        client
      ) =>
        await client.getResourceEvents(
          applicationName,
          applicationNamespace,
          resourceUID,
          resourceNamespace,
          resourceName
        )
    );
    this.addJsonOutputTool(
      'get_resources',
      'get_resources return manifests for resources specified by resourceRefs. If resourceRefs is empty or not provided, fetches all resources managed by the application.',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRefs: ResourceRefSchema.array().optional()
      },
      async ({ applicationName, applicationNamespace, resourceRefs }, client) => {
        let refs = resourceRefs || [];
        if (refs.length === 0) {
          const tree = await client.getApplicationResourceTree(applicationName);
          refs =
            tree.nodes?.map((node) => ({
              uid: node.uid!,
              version: node.version!,
              group: node.group!,
              kind: node.kind!,
              name: node.name!,
              namespace: node.namespace!
            })) || [];
        }
        return Promise.all(
          refs.map((ref) => client.getResource(applicationName, applicationNamespace, ref))
        );
      }
    );
    this.addJsonOutputTool(
      'get_resource_actions',
      'get_resource_actions returns actions for a resource that is managed by an application',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRef: ResourceRefSchema
      },
      async ({ applicationName, applicationNamespace, resourceRef }, client) =>
        await client.getResourceActions(
          applicationName,
          applicationNamespace,
          resourceRef as V1alpha1ResourceResult
        )
    );

    // Only register modification tools if not in read-only mode
    if (!isReadOnly) {
      this.addJsonOutputTool(
        'create_application',
        'create_application creates a new ArgoCD application in the specified namespace. The application.metadata.namespace field determines where the Application resource will be created (e.g., "argocd", "argocd-apps", or any custom namespace).',
        { application: ApplicationSchema },
        async ({ application }, client) =>
          await client.createApplication(application as V1alpha1Application)
      );
      this.addJsonOutputTool(
        'update_application',
        'update_application updates application',
        { applicationName: z.string(), application: ApplicationSchema },
        async ({ applicationName, application }, client) =>
          await client.updateApplication(applicationName, application as V1alpha1Application)
      );
      this.addJsonOutputTool(
        'delete_application',
        'delete_application deletes application. Specify applicationNamespace if the application is in a non-default namespace to avoid permission errors.',
        {
          applicationName: z.string(),
          applicationNamespace: ApplicationNamespaceSchema.optional().describe(
            'The namespace where the application is located. Required if application is not in the default namespace.'
          ),
          cascade: z
            .boolean()
            .optional()
            .describe('Whether to cascade the deletion to child resources'),
          propagationPolicy: z
            .string()
            .optional()
            .describe('Deletion propagation policy (e.g., "Foreground", "Background", "Orphan")')
        },
        async ({ applicationName, applicationNamespace, cascade, propagationPolicy }, client) => {
          const options: Record<string, string | boolean> = {};
          if (applicationNamespace) options.appNamespace = applicationNamespace;
          if (cascade !== undefined) options.cascade = cascade;
          if (propagationPolicy) options.propagationPolicy = propagationPolicy;

          return await client.deleteApplication(
            applicationName,
            Object.keys(options).length > 0 ? options : undefined
          );
        }
      );
      this.addJsonOutputTool(
        'sync_application',
        'sync_application syncs application. Specify applicationNamespace if the application is in a non-default namespace to avoid permission errors.',
        {
          applicationName: z.string(),
          applicationNamespace: ApplicationNamespaceSchema.optional().describe(
            'The namespace where the application is located. Required if application is not in the default namespace.'
          ),
          dryRun: z
            .boolean()
            .optional()
            .describe('Perform a dry run sync without applying changes'),
          prune: z
            .boolean()
            .optional()
            .describe('Remove resources that are no longer defined in the source'),
          revision: z
            .string()
            .optional()
            .describe('Sync to a specific revision instead of the latest'),
          syncOptions: z
            .array(z.string())
            .optional()
            .describe(
              'Additional sync options (e.g., ["CreateNamespace=true", "PrunePropagationPolicy=foreground"])'
            )
        },
        async (
          { applicationName, applicationNamespace, dryRun, prune, revision, syncOptions },
          client
        ) => {
          const options: Record<string, string | boolean | string[]> = {};
          if (applicationNamespace) options.appNamespace = applicationNamespace;
          if (dryRun !== undefined) options.dryRun = dryRun;
          if (prune !== undefined) options.prune = prune;
          if (revision) options.revision = revision;
          if (syncOptions) options.syncOptions = syncOptions;

          return await client.syncApplication(
            applicationName,
            Object.keys(options).length > 0 ? options : undefined
          );
        }
      );
      this.addJsonOutputTool(
        'run_resource_action',
        'run_resource_action runs an action on a resource',
        {
          applicationName: z.string(),
          applicationNamespace: ApplicationNamespaceSchema,
          resourceRef: ResourceRefSchema,
          action: z.string()
        },
        async ({ applicationName, applicationNamespace, resourceRef, action }, client) =>
          await client.runResourceAction(
            applicationName,
            applicationNamespace,
            resourceRef as V1alpha1ResourceResult,
            action
          )
      );
    }
  }

  // Resolve the ArgoCD client to use for a single tool call. The base URL may be
  // overridden per call via the argocdBaseUrl argument; the API token is never a
  // tool argument and is resolved by the following precedence:
  //
  //   1. Request token  — the session token from the x-argocd-api-token header /
  //      ARGOCD_API_TOKEN env var. If the caller supplied one, it ALWAYS wins.
  //   2. Registry token — when no request token was supplied, look the resolved
  //      base URL up in the configured token registry (ARGOCD_TOKEN_REGISTRY)
  //      and use its token if the base URL is registered.
  //
  // This lets a single server target multiple ArgoCD instances, each with its
  // own token, without the token ever appearing in a tool-call payload: callers
  // pass only the (non-secret) base URL and the server pairs it with the token.
  private resolveClient(args: ArgoCDArgs): ArgoCDClient {
    const baseUrl = args.argocdBaseUrl || this.defaultBaseUrl;

    // The base URL is optional at the session level; when no default is
    // configured, the caller must supply the argocdBaseUrl argument.
    if (!baseUrl) {
      throw new Error(
        'Missing required ArgoCD base URL: argocdBaseUrl. ' +
          'Provide it as a tool argument, or configure the server via the ' +
          'x-argocd-base-url header or ARGOCD_BASE_URL env var.'
      );
    }

    // Resolve the token for this base URL. The default (session) token is bound
    // to the default base URL ONLY: it must never be paired with a caller-
    // supplied base URL, or an attacker (or prompt-injected model) could set
    // argocdBaseUrl to an arbitrary host and have the server send the default
    // token there (token exfiltration). For any overridden base URL, the token
    // must come from the registry — i.e. the operator explicitly registered it.
    const isDefaultBaseUrl =
      TokenRegistry.normalize(baseUrl) === TokenRegistry.normalize(this.defaultBaseUrl);
    const apiToken = isDefaultBaseUrl
      ? this.defaultApiToken || this.tokenRegistry.getToken(baseUrl)
      : this.tokenRegistry.getToken(baseUrl);

    if (!apiToken) {
      throw new Error(
        `Missing required ArgoCD API token for base URL "${baseUrl}". ` +
          'Provide it via the x-argocd-api-token header / ARGOCD_API_TOKEN env var, ' +
          'or register a token for this base URL in ARGOCD_TOKEN_REGISTRY.'
      );
    }

    // Fast path: default base URL with the default token — reuse the session client.
    if (baseUrl === this.defaultBaseUrl && apiToken === this.defaultApiToken) {
      return this.argocdClient;
    }

    // Cache clients keyed by baseUrl + token: the same base URL can resolve to
    // different tokens depending on whether a request token was supplied.
    const cacheKey = `${baseUrl} ${apiToken}`;
    let client = this.clientCache.get(cacheKey);
    if (!client) {
      client = new ArgoCDClient(baseUrl, apiToken);
      this.clientCache.set(cacheKey, client);
    }
    return client;
  }

  private addJsonOutputTool<Args extends ZodRawShape, T>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: (
      cbArgs: Parameters<ToolCallback<Args>>[0],
      client: ArgoCDClient,
      extra: Parameters<ToolCallback<Args>>[1]
    ) => T
  ) {
    const mergedSchema = { ...paramsSchema, ...argoCDArgsSchema } as ZodRawShape;
    this.tool(name, description, mergedSchema, async (...args) => {
      try {
        const [allArgs, extra] = args as [
          Parameters<ToolCallback<Args>>[0] & ArgoCDArgs,
          Parameters<ToolCallback<Args>>[1]
        ];
        // Strip credential args before handing the rest to the tool callback.
        const { argocdBaseUrl, ...toolArgs } = allArgs;
        const client = this.resolveClient({ argocdBaseUrl });
        const result = await cb.call(
          this,
          toolArgs as Parameters<ToolCallback<Args>>[0],
          client,
          extra
        );
        return {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
        };
      }
    });
  }
}

export const createServer = (serverInfo: ServerInfo) => {
  return new Server(serverInfo);
};
