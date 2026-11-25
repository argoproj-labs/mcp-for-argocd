import {
  ApplicationLogEntry,
  V1alpha1Application,
  V1alpha1ApplicationList,
  V1alpha1ApplicationTree,
  V1EventList,
  V1alpha1ResourceAction,
  V1alpha1ResourceDiff,
  V1alpha1ResourceResult,
  V1alpha1ApplicationResourceResult,
  V1alpha1ClusterList,
  V1alpha1AppProject,
  V1alpha1AppProjectList
} from '../types/argocd-types.js';
import { HttpClient } from './http.js';

/**
 * Matches an application destination against a set of cluster identifiers
 * (names and/or API server URLs). Applications may reference their destination
 * cluster either by name (`spec.destination.name`) or by API server URL
 * (`spec.destination.server`), so both fields are checked.
 */
export const matchesDestCluster = (
  destination: { name?: string; server?: string } | undefined,
  identifiers: ReadonlySet<string>
): boolean =>
  (destination?.name != null && identifiers.has(destination.name)) ||
  (destination?.server != null && identifiers.has(destination.server));

// MCP clients cap the size of a tool result and cut the middle out of anything
// larger, which turns an oversized list into a silently partial one. The list
// tools therefore paginate by default instead of returning everything: a short
// page plus explicit `hasMore` is always a correct answer, a truncated JSON
// never is.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const paginate = <T>(items: T[], params?: { limit?: number; offset?: number }) => {
  const start = Math.max(params?.offset ?? 0, 0);
  const limit = Math.min(Math.max(params?.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const end = start + limit;
  const page = items.slice(start, end);
  return {
    items: page,
    metadata: {
      totalItems: items.length,
      returnedItems: page.length,
      offset: start,
      limit,
      hasMore: end < items.length
    }
  };
};

export class ArgoCDClient {
  private baseUrl: string;
  private apiToken: string;
  private client: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.client = new HttpClient(this.baseUrl, this.apiToken);
  }

  public async listApplications(params?: {
    search?: string;
    project?: string;
    destCluster?: string;
    limit?: number;
    offset?: number;
  }) {
    const queryParams: Record<string, string> = {};
    if (params?.search) queryParams.search = params.search;
    // The ArgoCD API filters by project server-side via the (repeatable)
    // `projects` query parameter; a single value is enough here.
    if (params?.project) queryParams.projects = params.project;

    const { body } = await this.client.get<V1alpha1ApplicationList>(
      `/api/v1/applications`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    // Strip heavy fields to reduce token usage: the full source (helm/kustomize
    // parameters), sync.comparedTo (a copy of source + destination) and
    // status.summary (image/URL lists) are dropped; get_application returns
    // the complete resource for a single application.
    let strippedItems =
      body.items?.map((app) => ({
        metadata: {
          name: app.metadata?.name,
          namespace: app.metadata?.namespace,
          labels: app.metadata?.labels,
          creationTimestamp: app.metadata?.creationTimestamp
        },
        spec: {
          project: app.spec?.project,
          source: app.spec?.source && {
            repoURL: app.spec.source.repoURL,
            path: app.spec.source.path,
            chart: app.spec.source.chart,
            targetRevision: app.spec.source.targetRevision
          },
          destination: app.spec?.destination
        },
        status: {
          sync: app.status?.sync && {
            status: app.status.sync.status,
            revision: app.status.sync.revision
          },
          health: app.status?.health
        }
      })) ?? [];

    // The applications list API cannot filter by destination cluster, so the
    // filter is applied here, after stripping and before pagination. The
    // identifier is first resolved against the registered clusters so that
    // applications referencing the destination by the other identifier (name
    // vs. API server URL) are matched too.
    if (params?.destCluster) {
      const identifiers = await this.resolveDestClusterIdentifiers(params.destCluster);
      strippedItems = strippedItems.filter((app) =>
        matchesDestCluster(app.spec.destination, identifiers)
      );
    }

    // Apply pagination. The limit is enforced even when the caller omits it:
    // an unfiltered inventory is thousands of applications and would come back
    // to the model with its middle cut away.
    const { items, metadata } = paginate(strippedItems, params);

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        ...metadata
      }
    };
  }

  /**
   * Expands a destination-cluster identifier (name or API server URL) with the
   * matching registered cluster's other identifier, so applications that
   * reference the destination either way are matched. Falls back to the raw
   * identifier when the clusters cannot be listed (e.g. missing RBAC).
   */
  private async resolveDestClusterIdentifiers(destCluster: string): Promise<Set<string>> {
    const identifiers = new Set([destCluster]);
    try {
      const clusters = await this.listClusters();
      for (const cluster of clusters.items ?? []) {
        if (cluster.name === destCluster || cluster.server === destCluster) {
          if (cluster.name) identifiers.add(cluster.name);
          if (cluster.server) identifiers.add(cluster.server);
        }
      }
    } catch {
      // Ignore: matching proceeds with the raw identifier only.
    }
    return identifiers;
  }

  public async listClusters(params?: { server?: string; name?: string }) {
    const queryParams: Record<string, string> = {};
    if (params?.server) queryParams.server = params.server;
    if (params?.name) queryParams.name = params.name;

    const { body } = await this.client.get<V1alpha1ClusterList>(
      `/api/v1/clusters`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    // Cluster items are stripped for the same reason as the application ones:
    // info.apiVersions alone lists every group/version served by a cluster
    // (hundreds of strings each), and config/info.cacheInfo add more weight on
    // top. A deployment with a few dozen clusters overflows the client-side
    // output limit, the middle of the list is cut away and the caller silently
    // receives a partial inventory. Identity plus health is what a list is for;
    // the connection message is kept because there is no per-cluster get tool
    // to fall back to when a cluster is unreachable.
    const items =
      body.items?.map((cluster) => ({
        name: cluster.name,
        server: cluster.server,
        serverVersion: cluster.serverVersion || cluster.info?.serverVersion,
        applicationsCount: cluster.info?.applicationsCount,
        connectionState: cluster.connectionState && {
          status: cluster.connectionState.status,
          message: cluster.connectionState.message,
          attemptedAt: cluster.connectionState.attemptedAt
        }
      })) ?? [];

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        totalItems: items.length
      }
    };
  }

  public async getApplication(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      queryParams
    );
    return body;
  }

  public async getAppProject(projectName: string) {
    const { body } = await this.client.get<V1alpha1AppProject>(`/api/v1/projects/${projectName}`);
    return body;
  }

  public async listProjects(params?: { search?: string; limit?: number; offset?: number }) {
    const { body } = await this.client.get<V1alpha1AppProjectList>(`/api/v1/projects`);

    // A project list answers "which projects exist"; the repository allow-list
    // and the destination allow-list behind each project are what make the
    // response heavy, so they are reduced to counts here and returned in full
    // by get_appproject for the single project the caller cares about.
    let strippedItems =
      body.items?.map((project) => ({
        name: project.metadata?.name,
        description: project.spec?.description,
        sourceReposCount: project.spec?.sourceRepos?.length ?? 0,
        destinationsCount: project.spec?.destinations?.length ?? 0,
        creationTimestamp: project.metadata?.creationTimestamp
      })) ?? [];

    // The projects API has no server-side search, so the substring filter is
    // applied here — same contract as list_applications.
    if (params?.search) {
      const needle = params.search.toLowerCase();
      strippedItems = strippedItems.filter((project) =>
        project.name?.toLowerCase().includes(needle)
      );
    }

    const { items, metadata } = paginate(strippedItems, params);

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        ...metadata
      }
    };
  }

  public async createApplication(application: V1alpha1Application) {
    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications`,
      null,
      application
    );
    return body;
  }

  public async updateApplication(applicationName: string, application: V1alpha1Application) {
    const { body } = await this.client.put<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      null,
      application
    );
    return body;
  }

  public async deleteApplication(
    applicationName: string,
    options?: {
      appNamespace?: string;
      cascade?: boolean;
      propagationPolicy?: string;
    }
  ) {
    const queryParams: Record<string, string | boolean> = {};

    if (options?.appNamespace) {
      queryParams.appNamespace = options.appNamespace;
    }
    if (options?.cascade !== undefined) {
      queryParams.cascade = options.cascade;
    }
    if (options?.propagationPolicy) {
      queryParams.propagationPolicy = options.propagationPolicy;
    }

    const { body } = await this.client.delete<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );
    return body;
  }

  public async syncApplication(
    applicationName: string,
    options?: {
      appNamespace?: string;
      dryRun?: boolean;
      prune?: boolean;
      revision?: string;
      syncOptions?: string[];
    }
  ) {
    const syncRequest: Record<string, string | boolean | string[]> = {};

    if (options?.appNamespace) {
      syncRequest.appNamespace = options.appNamespace;
    }
    if (options?.dryRun !== undefined) {
      syncRequest.dryRun = options.dryRun;
    }
    if (options?.prune !== undefined) {
      syncRequest.prune = options.prune;
    }
    if (options?.revision) {
      syncRequest.revision = options.revision;
    }
    if (options?.syncOptions) {
      syncRequest.syncOptions = options.syncOptions;
    }

    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      `/api/v1/applications/${applicationName}/sync`,
      null,
      Object.keys(syncRequest).length > 0 ? syncRequest : undefined
    );
    return body;
  }

  public async getApplicationResourceTree(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1ApplicationTree>(
      `/api/v1/applications/${applicationName}/resource-tree`,
      queryParams
    );
    return body;
  }

  public async getApplicationManagedResources(
    applicationName: string,
    filters?: {
      namespace?: string;
      name?: string;
      version?: string;
      group?: string;
      kind?: string;
      appNamespace?: string;
      project?: string;
    }
  ) {
    const { body } = await this.client.get<{ items: V1alpha1ResourceDiff[] }>(
      `/api/v1/applications/${applicationName}/managed-resources`,
      filters
    );
    return body;
  }

  public async getApplicationLogs(applicationName: string) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getWorkloadLogs(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    container: string
  ) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/logs`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version,
        follow: false,
        tailLines: 100,
        container: container
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getPodLogs(applicationName: string, podName: string) {
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `/api/v1/applications/${applicationName}/pods/${podName}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => logs.push(chunk)
    );
    return logs;
  }

  public async getApplicationEvents(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1EventList>(
      `/api/v1/applications/${applicationName}/events`,
      queryParams
    );
    return body;
  }

  public async getResource(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const { body } = await this.client.get<V1alpha1ApplicationResourceResult>(
      `/api/v1/applications/${applicationName}/resource`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      }
    );
    return body.manifest;
  }

  public async getResourceEvents(
    applicationName: string,
    applicationNamespace: string,
    resourceUID: string,
    resourceNamespace: string,
    resourceName: string
  ) {
    const { body } = await this.client.get<V1EventList>(
      `/api/v1/applications/${applicationName}/events`,
      {
        appNamespace: applicationNamespace,
        resourceNamespace,
        resourceUID,
        resourceName
      }
    );
    return body;
  }

  public async getResourceActions(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const { body } = await this.client.get<{ actions: V1alpha1ResourceAction[] }>(
      `/api/v1/applications/${applicationName}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      }
    );
    return body;
  }

  public async runResourceAction(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    action: string
  ) {
    const { body } = await this.client.post<string, V1alpha1Application>(
      `/api/v1/applications/${applicationName}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      action
    );
    return body;
  }
}
