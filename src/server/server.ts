import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';

import packageJSON from '../../package.json' with { type: 'json' };
import { ArgoCDClient } from '../argocd/client.js';
import { ArgoCDConfig } from '../config/index.js';
import { z, ZodRawShape } from 'zod';
import { V1alpha1Application, V1alpha1ResourceResult } from '../types/argocd-types.js';
import {
  ApplicationNamespaceSchema,
  ApplicationSchema,
  ResourceRefSchema
} from '../shared/models/schema.js';

type ServerInfo = {
  argocdConfig: ArgoCDConfig;
};

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
    this.defaultInstanceId =
      serverInfo.argocdConfig.defaultInstanceId || serverInfo.argocdConfig.instances[0].id;

    // Create a client for each configured instance
    for (const instance of serverInfo.argocdConfig.instances) {
      this.argocdClients.set(
        instance.id,
        new ArgoCDClient(instance.baseUrl, instance.apiToken)
      );
    }

    const isReadOnly =
      String(process.env.MCP_READ_ONLY ?? '')
        .trim()
        .toLowerCase() === 'true';

    // Always register read/query tools
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
        project: z.string().optional().describe('Filter by ArgoCD project name. Optional.'),
        repo: z.string().optional().describe('Filter by repository URL. Optional.'),
        selector: z
          .string()
          .optional()
          .describe(
            'Filter by label selector (e.g., "env=prod,team=backend" or "app.kubernetes.io/name=my-app"). Optional.'
          ),
        appNamespace: z
          .string()
          .optional()
          .describe('Filter by ArgoCD application namespace. Optional.'),
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
    this.addJsonOutputTool(
      'get_application_resource_tree',
      'get_application_resource_tree returns resource tree for application by application name',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string()
      },
      async ({ argocdInstanceId, applicationName }) => {
        const client = this.getClient(argocdInstanceId);
        return await client.getApplicationResourceTree(applicationName);
      }
    );
    this.addJsonOutputTool(
      'get_application_managed_resources',
      'get_application_managed_resources returns managed resources for application by application name with optional filtering. Use filters to avoid token limits with large applications. Examples: kind="ConfigMap" for config maps only, namespace="production" for specific namespace, or combine multiple filters.',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
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
      async ({ argocdInstanceId, applicationName, kind, namespace, name, version, group, appNamespace, project }) => {
        const client = this.getClient(argocdInstanceId);
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
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRef: ResourceRefSchema,
        container: z.string()
      },
      async ({ argocdInstanceId, applicationName, applicationNamespace, resourceRef, container }) => {
        const client = this.getClient(argocdInstanceId);
        return await client.getWorkloadLogs(
          applicationName,
          applicationNamespace,
          resourceRef as V1alpha1ResourceResult,
          container
        );
      }
    );
    this.addJsonOutputTool(
      'get_application_events',
      'get_application_events returns events for application by application name',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string()
      },
      async ({ argocdInstanceId, applicationName }) => {
        const client = this.getClient(argocdInstanceId);
        return await client.getApplicationEvents(applicationName);
      }
    );
    this.addJsonOutputTool(
      'get_resource_events',
      'get_resource_events returns events for a resource that is managed by an application',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceUID: z.string(),
        resourceNamespace: z.string(),
        resourceName: z.string()
      },
      async ({
        argocdInstanceId,
        applicationName,
        applicationNamespace,
        resourceUID,
        resourceNamespace,
        resourceName
      }) => {
        const client = this.getClient(argocdInstanceId);
        return await client.getResourceEvents(
          applicationName,
          applicationNamespace,
          resourceUID,
          resourceNamespace,
          resourceName
        );
      }
    );
    this.addJsonOutputTool(
      'get_resources',
      'get_resources return manifests for resources specified by resourceRefs. If resourceRefs is empty or not provided, fetches all resources managed by the application.',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRefs: ResourceRefSchema.array().optional()
      },
      async ({ argocdInstanceId, applicationName, applicationNamespace, resourceRefs }) => {
        const client = this.getClient(argocdInstanceId);
        let refs = resourceRefs || [];
        if (refs.length === 0) {
          const tree = await client.getApplicationResourceTree(applicationName);
          refs =
            tree.nodes?.map((node: any) => ({
              uid: node.uid!,
              version: node.version!,
              group: node.group!,
              kind: node.kind!,
              name: node.name!,
              namespace: node.namespace!
            })) || [];
        }
        return Promise.all(
          refs.map((ref) =>
            client.getResource(applicationName, applicationNamespace, ref)
          )
        );
      }
    );
    this.addJsonOutputTool(
      'get_resource_actions',
      'get_resource_actions returns actions for a resource that is managed by an application',
      {
        argocdInstanceId: z
          .string()
          .optional()
          .describe(
            'ID of the ArgoCD instance to query. If not specified, uses the default instance.'
          ),
        applicationName: z.string(),
        applicationNamespace: ApplicationNamespaceSchema,
        resourceRef: ResourceRefSchema
      },
      async ({ argocdInstanceId, applicationName, applicationNamespace, resourceRef }) => {
        const client = this.getClient(argocdInstanceId);
        return await client.getResourceActions(
          applicationName,
          applicationNamespace,
          resourceRef as V1alpha1ResourceResult
        );
      }
    );
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

    // Only register modification tools if not in read-only mode
    if (!isReadOnly) {
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
      this.addJsonOutputTool(
        'update_application',
        'update_application updates application',
        {
          argocdInstanceId: z
            .string()
            .optional()
            .describe(
              'ID of the ArgoCD instance to update the application in. If not specified, uses the default instance.'
            ),
          applicationName: z.string(),
          application: ApplicationSchema
        },
        async ({ argocdInstanceId, applicationName, application }) => {
          const client = this.getClient(argocdInstanceId);
          return await client.updateApplication(
            applicationName,
            application as V1alpha1Application
          );
        }
      );
      this.addJsonOutputTool(
        'delete_application',
        'delete_application deletes application. Specify applicationNamespace if the application is in a non-default namespace to avoid permission errors.',
        {
          argocdInstanceId: z
            .string()
            .optional()
            .describe(
              'ID of the ArgoCD instance to delete the application from. If not specified, uses the default instance.'
            ),
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
        async ({ argocdInstanceId, applicationName, applicationNamespace, cascade, propagationPolicy }) => {
          const client = this.getClient(argocdInstanceId);
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
          argocdInstanceId: z
            .string()
            .optional()
            .describe(
              'ID of the ArgoCD instance to sync the application in. If not specified, uses the default instance.'
            ),
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
        async ({ argocdInstanceId, applicationName, applicationNamespace, dryRun, prune, revision, syncOptions }) => {
          const client = this.getClient(argocdInstanceId);
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
          argocdInstanceId: z
            .string()
            .optional()
            .describe(
              'ID of the ArgoCD instance to run the action in. If not specified, uses the default instance.'
            ),
          applicationName: z.string(),
          applicationNamespace: ApplicationNamespaceSchema,
          resourceRef: ResourceRefSchema,
          action: z.string()
        },
        async ({ argocdInstanceId, applicationName, applicationNamespace, resourceRef, action }) => {
          const client = this.getClient(argocdInstanceId);
          return await client.runResourceAction(
            applicationName,
            applicationNamespace,
            resourceRef as V1alpha1ResourceResult,
            action
          );
        }
      );
    }
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

  private addJsonOutputTool<Args extends ZodRawShape, T>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: (...cbArgs: Parameters<ToolCallback<Args>>) => T
  ) {
    this.tool(name, description, paramsSchema as ZodRawShape, async (...args) => {
      try {
        const result = await cb.apply(this, args as Parameters<ToolCallback<Args>>);
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
