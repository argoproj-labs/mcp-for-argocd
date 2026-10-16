import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';

import packageJSON from '../../package.json' with { type: 'json' };
import { ArgoCDClient } from '../argocd/client.js';
import { z, ZodRawShape } from 'zod';
import { V1alpha1Application, V1alpha1ResourceResult } from '../types/argocd-types.js';
import {
  ApplicationNamespaceSchema,
  ApplicationSchema,
  HelmOverridesSchema,
  KustomizeOverridesSchema,
  ParameterUnsetSchema,
  ResourceRefSchema
} from '../shared/models/schema.js';
import {
  applyParameterOverrides,
  buildPatchOps,
  detectDurability,
  isNonEmptyBlock,
  resolveTargetSource,
  type AppSpec,
  type DurabilityInput,
  type HelmOverrides,
  type KustomizeOverrides,
  type ParameterUnset
} from '../shared/parameters.js';
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
        'set_application_parameters',
        'set_application_parameters sets and unsets Helm and Kustomize parameter overrides on an existing application, writing them to the application spec (the same place "argocd app set -p" writes). Listed values are upserted and unlisted ones are kept; use "unset" to remove. Removing and setting in one call replaces a list wholesale, because unset is applied first. A helm.valueFiles entry is appended rather than replacing the list, and Helm gives the last file the highest precedence, so an appended file wins over the ones already there; to place it earlier, unset the existing entries and set the whole list in the order you want. Kustomize images are matched on the name before the first of "=", ":", "@" occurring anywhere, in that priority order, as "argocd app set --kustomize-image" does — so "nginx@sha256:abc" is matched on "nginx@sha256" and is added alongside a tagged "nginx:1.2" rather than replacing it, and with no "=" present "localhost:5000/nginx:1.2" is matched on "localhost" and so replaces any other "localhost:5000/..." image that also has no "="; the returned changes list says which entry each image actually touched. IMPORTANT: if the application has an automated sync policy, this call deploys — Argo CD picks up the spec change without any further request, and the response reports autoSyncEnabled. The response also reports "durability": when durable is false the application is generated by an ApplicationSet or managed by a parent application, and the override is likely to be reverted on the next reconcile — the reported note states the condition under which it survives. When durable is true, no ApplicationSet owner reference and no parent-application tracking value were found, which is weaker than a guarantee that the override survives: detection reads owner references, and Kubernetes forbids a cross-namespace owner reference, so an ApplicationSet that generates applications into a namespace other than its own leaves none on them and they are reported durable. dryRun previews the merged result without writing, but it is a local preview only and cannot detect server-side failures such as a parameter the chart rejects.',
        {
          // Constrained to a Kubernetes resource name because this is the one tool that
          // reads an application and then writes it back: the name is interpolated raw
          // into the URL path of both requests, so a name carrying a query string
          // ("my-app?appNamespace=other") makes the GET read one application while the
          // PATCH — which takes appNamespace from the body, not the path — writes a
          // different one, and a name carrying "../" retargets the path outright. The
          // merge would then be computed from one application and applied to another,
          // and the whole-block `add` branch emits no `test` op to catch it.
          applicationName: z
            .string()
            .min(1)
            .max(253)
            .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
            .describe(
              'The name of the application to modify. A plain Kubernetes resource name (lowercase alphanumerics, "-" and ".", starting and ending alphanumeric) — not a path, a URL, or a name with a query string. Use applicationNamespace to target another namespace.'
            ),
          applicationNamespace: ApplicationNamespaceSchema.optional().describe(
            'The namespace where the application is located. Required if the application is not in the default namespace.'
          ),
          sourceIndex: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Which source to modify on a multi-source application (0-based index into spec.sources). Omit for a single-source application. If you omit it on a multi-source application, the error lists the available indexes.'
            ),
          helm: HelmOverridesSchema.optional().describe('Helm overrides to upsert.'),
          kustomize: KustomizeOverridesSchema.optional().describe('Kustomize overrides to upsert.'),
          unset: ParameterUnsetSchema.optional().describe(
            'Overrides to remove. Applied before the set values.'
          ),
          dryRun: z
            .boolean()
            .optional()
            .describe(
              'Preview the merged result without writing. Local preview only, not server-side validation.'
            )
        },
        async (
          { applicationName, applicationNamespace, sourceIndex, helm, kustomize, unset, dryRun },
          client
        ) => {
          const app = await client.getApplication(applicationName, applicationNamespace);
          // getApplication cannot fail loudly: the shared request() does not check
          // response.ok, so an error response arrives as a RuntimeError body cast to
          // the application type. Surface the raw body instead of dereferencing it.
          if (!app?.spec) {
            throw new Error(
              `ArgoCD returned no spec for application "${applicationName}": ${JSON.stringify(app)}`
            );
          }

          // Both casts go through unknown because the generated types do not describe the
          // wire format: the spec reaches V1alpha1KustomizeReplica.count, declared as the
          // IntstrIntOrString struct, which has no overlap with the local `number | string`.
          // That mismatch is the reason the local types exist.
          const spec = app.spec as unknown as AppSpec;
          const targetSource = resolveTargetSource(spec, sourceIndex);
          const { source: mergedSource, changes } = applyParameterOverrides(targetSource, {
            helm: helm as HelmOverrides | undefined,
            kustomize: kustomize as KustomizeOverrides | undefined,
            unset: unset as ParameterUnset | undefined
          });

          const durability = detectDurability(app as unknown as DurabilityInput);
          // Read through the generated type rather than the local AppSpec, whose index
          // signature types every unmodelled field — syncPolicy included — as unknown.
          const autoSyncEnabled = Boolean(app.spec.syncPolicy?.automated);
          const report = {
            dryRun: Boolean(dryRun),
            sourceIndex: sourceIndex ?? null,
            autoSyncEnabled,
            durability,
            changes,
            source: mergedSource
          };

          // A no-op patch still bumps the application and can trip automated sync,
          // so not writing is the correct response to "nothing to do".
          if (changes.length === 0) {
            return { ...report, applied: false, reason: 'no changes to apply' };
          }

          // An Argo CD source has exactly one type: ExplicitType() errors with "multiple
          // application sources defined" when two of helm/kustomize/plugin are non-zero, so
          // a source carrying both blocks cannot be rendered at all — and on an application
          // with automated sync that is a failed sync rather than a wrong parameter. Two
          // shapes get here: both blocks passed in one call, and one block passed to a
          // source that already has the other, which a model asked to bump an image tag on
          // a Kustomize application can reach by reaching for helm.parameters.
          //
          // Refused before the dryRun return as well: a preview that reports this merge as
          // the result, without saying Argo CD will not render it, is the wrong answer to
          // the question dryRun is asked.
          if (isNonEmptyBlock(mergedSource.helm) && isNonEmptyBlock(mergedSource.kustomize)) {
            const alreadySet = [
              isNonEmptyBlock(targetSource.helm) ? 'helm' : undefined,
              isNonEmptyBlock(targetSource.kustomize) ? 'kustomize' : undefined
            ].filter((block) => block !== undefined);
            throw new Error(
              `These overrides would leave the source of application "${applicationName}" holding both a helm block and a kustomize block, and an application's source can only have one type — Argo CD refuses to render a source with more than one, so this would break the application rather than change it. ` +
                (alreadySet.length > 0
                  ? `This source already has: ${alreadySet.join(' and ')}. `
                  : '') +
                'Send overrides of one type only, or clear the other block first with unset.'
            );
          }

          if (dryRun) {
            return { ...report, applied: false, reason: 'dryRun: nothing was written' };
          }

          const ops = buildPatchOps(sourceIndex, targetSource, mergedSource, changes);
          // A non-empty change list can still yield an empty patch document: a field the
          // merge emptied that was already absent needs no op, and neither does a block
          // that did not exist and came out holding nothing but empty containers. Sending
          // an empty patch would report a write that never happened.
          if (ops.length === 0) {
            return {
              ...report,
              applied: false,
              reason:
                'no patch was needed: every changed field is empty and already absent from the application spec'
            };
          }

          try {
            await client.patchApplication(applicationName, ops, {
              appNamespace: applicationNamespace
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A failed RFC 6902 test op means the fields we merged against changed under
            // us, so our merge was computed from a stale read. Matched on json-patch's
            // wording ("testing value <path> failed: test failed") and unanchored, since
            // the HTTP client prefixes the message with the URL and status. Deliberately
            // not matched on a bare "test": that word reaches this message through an
            // application name, a namespace, or an error body echoing the patch document,
            // and telling the caller to re-read and retry would send them straight past a
            // permission error that no retry fixes.
            if (/testing value .*failed|\btest failed\b/i.test(message)) {
              throw new Error(
                `The parameters of application "${applicationName}" were modified concurrently, so the override was not applied. Re-read the application and retry. Underlying error: ${message}`
              );
            }
            throw error;
          }

          return { ...report, applied: true };
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
