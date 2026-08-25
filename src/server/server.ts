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

// Serialized tool responses larger than this are replaced with an error that
// tells the model how to narrow the query, instead of flooding (or exceeding)
// the client's context window. Override with MCP_MAX_RESPONSE_CHARS; 0 disables.
const DEFAULT_MAX_RESPONSE_CHARS = 100_000;

export class Server extends McpServer {
  private defaultBaseUrl: string;
  private defaultApiToken: string;
  private tokenRegistry: TokenRegistry;
  private argocdClient: ArgoCDClient;
  private maxResponseChars: number;
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

    const rawMaxChars = (process.env.MCP_MAX_RESPONSE_CHARS ?? '').trim();
    const parsedMaxChars = rawMaxChars ? Number(rawMaxChars) : NaN;
    this.maxResponseChars =
      Number.isFinite(parsedMaxChars) && parsedMaxChars >= 0
        ? parsedMaxChars
        : DEFAULT_MAX_RESPONSE_CHARS;

    const isReadOnly =
      String(process.env.MCP_READ_ONLY ?? '')
        .trim()
        .toLowerCase() === 'true';

    // Always register read/query tools
    this.addJsonOutputTool(
      'list_applications',
      'list_applications returns a paginated, summarized list of applications (at most `limit` per call, default 50). Response metadata carries totalItems/returnedItems/hasMore for paging; heavy fields such as inline Helm values are omitted — use get_application for full details of one application. For a count, call with limit=1 and read metadata.totalItems.',
      {
        search: z
          .string()
          .optional()
          .describe(
            'Filter applications by name: case-insensitive partial match, applied after any server-side filters. Does not support glob patterns (e.g. "*"). Optional.'
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Maximum number of applications to return. Defaults to 50; check metadata.hasMore and page with offset if more exist. Optional.'
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Number of applications to skip before returning results. Use with limit for pagination. Optional.'
          ),
        projects: z
          .array(z.string())
          .optional()
          .describe('Filter server-side to applications in these ArgoCD projects. Optional.'),
        selector: z
          .string()
          .optional()
          .describe(
            'Filter server-side by Kubernetes label selector (e.g. "team=payments,env!=dev"). Optional.'
          ),
        repo: z
          .string()
          .optional()
          .describe('Filter server-side by source repository URL. Optional.'),
        detail: z
          .enum(['name', 'summary'])
          .optional()
          .describe(
            'Detail level per application. "summary" (default) returns stripped metadata/spec/status; "name" returns only name, namespace, project, sync status, and health status — use it for fleet-wide sweeps. Optional.'
          )
      },
      async ({ search, limit, offset, projects, selector, repo, detail }, client) =>
        await client.listApplications({
          search: search ?? undefined,
          limit,
          offset,
          projects,
          selector,
          repo,
          detail
        }),
      {
        oversizeHint:
          'Narrow the query: lower `limit` (paging with `offset`), filter with `search`/`projects`/`selector`/`repo`, or set detail:"name" for a minimal fleet-wide listing.'
      }
    );
    this.addJsonOutputTool(
      'list_clusters',
      'list_clusters returns a summarized list of clusters registered with ArgoCD (name, server, connection state, app count, server version; connection config and supported API versions are omitted).',
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
      'get_application returns application by application name. Optionally specify the application namespace to get applications from non-default namespaces. Heavy status fields (managedFields, sync history, full operation state, sync.comparedTo) are omitted by default; set includeHistory/includeOperationState to fetch them.',
      {
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema.optional(),
        includeHistory: z
          .boolean()
          .optional()
          .describe(
            'Include status.history (past sync revisions). Adds significant size. Optional.'
          ),
        includeOperationState: z
          .boolean()
          .optional()
          .describe(
            'Include the full status.operationState (per-resource sync results) instead of the default phase/message summary. Adds significant size. Optional.'
          )
      },
      async (
        { applicationName, applicationNamespace, includeHistory, includeOperationState },
        client
      ) =>
        await client.getApplication(applicationName, applicationNamespace, {
          includeHistory,
          includeOperationState
        }),
      'Retry without includeHistory/includeOperationState, or use get_application_resource_tree / get_application_managed_resources with filters for resource-level detail.'
    );
    this.addJsonOutputTool(
      'get_appproject',
      'get_appproject returns an ArgoCD AppProject (project) by its name. AppProjects provide a logical grouping of applications and define allowed sources, destinations, cluster/repository whitelists, and RBAC roles.',
      {
        projectName: z.string().describe('The name of the ArgoCD AppProject to fetch.')
      },
      async ({ projectName }, client) => await client.getAppProject(projectName)
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
      },
      'Filter by kind/namespace/name (or their combination) to reduce the payload.'
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
      },
      {
        oversizeHint:
          'Pass specific resourceRefs (from get_application_resource_tree) instead of fetching every resource in the application.'
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
          await client.createApplication(application as V1alpha1Application),
        {
          mutating: true,
          oversizeHint: 'Use get_application to inspect the created application.'
        }
      );
      this.addJsonOutputTool(
        'update_application',
        'update_application updates application',
        { applicationName: z.string(), application: ApplicationSchema },
        async ({ applicationName, application }, client) =>
          await client.updateApplication(applicationName, application as V1alpha1Application),
        {
          mutating: true,
          oversizeHint: 'Use get_application to inspect the updated application.'
        }
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
        },
        { mutating: true }
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
        },
        {
          mutating: true,
          oversizeHint: 'Use get_application to inspect the sync status.'
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
          ),
        {
          mutating: true,
          oversizeHint: 'Use get_application_resource_tree to inspect the affected resource.'
        }
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

  // oversizeHint is appended to the size-guard message so the model knows how to
  // proceed: for read tools, which parameters narrow the response; for mutating
  // tools, how to inspect the result of an operation whose response was omitted.
  //
  // mutating marks tools whose callback changes ArgoCD state (create/update/
  // delete/sync/run action). By the time the size guard runs, the operation has
  // already happened, so an oversized response must never be reported as a tool
  // error: a client that treats isError as failure would retry — repeating a
  // sync, or failing a create with "already exists". Instead the payload is
  // replaced with a success notice that says not to retry.
  private addJsonOutputTool<Args extends ZodRawShape, T>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: (
      cbArgs: Parameters<ToolCallback<Args>>[0],
      client: ArgoCDClient,
      extra: Parameters<ToolCallback<Args>>[1]
    ) => T,
    options?: { oversizeHint?: string; mutating?: boolean }
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
        const text = JSON.stringify(result);
        if (this.maxResponseChars > 0 && text.length > this.maxResponseChars) {
          const limit =
            `${text.length} characters exceeds the ${this.maxResponseChars}-character limit ` +
            '(MCP_MAX_RESPONSE_CHARS)';
          if (options?.mutating) {
            return {
              isError: false,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `${name} completed successfully, but its response was omitted: ${limit}. ` +
                    'Do not retry the operation. ' +
                    (options.oversizeHint ?? 'Use the read tools to inspect the result.')
                }
              ]
            };
          }
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `${name} response too large to return: ${limit}. ` +
                  (options?.oversizeHint ??
                    "Narrow the query with the tool's filtering or pagination parameters and retry.")
              }
            ]
          };
        }
        return {
          isError: false,
          content: [{ type: 'text', text }]
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
