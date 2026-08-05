import {
  ApplicationLogEntry,
  V1alpha1Application,
  V1alpha1ApplicationList,
  V1alpha1ApplicationSource,
  V1alpha1ApplicationTree,
  V1EventList,
  V1alpha1ResourceAction,
  V1alpha1ResourceDiff,
  V1alpha1ResourceResult,
  V1alpha1ApplicationResourceResult,
  V1alpha1ClusterList,
  V1alpha1AppProject
} from '../types/argocd-types.js';
import { HttpClient } from './http.js';

// Applications returned by list_applications when no limit is given. ArgoCD's
// list API has no server-side pagination, so this is the only bound between an
// unwitting caller and the whole fleet in one response.
const DEFAULT_LIST_LIMIT = 50;

// Reduce an ApplicationSource to the fields that identify it. Inline Helm
// values (helm.values / helm.valuesObject) routinely dominate list payloads;
// get_application returns them.
const stripSource = (source?: V1alpha1ApplicationSource) =>
  source && {
    repoURL: source.repoURL,
    path: source.path,
    chart: source.chart,
    targetRevision: source.targetRevision,
    ref: source.ref,
    name: source.name
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
    limit?: number;
    offset?: number;
    projects?: string[];
    selector?: string;
    repo?: string;
    detail?: 'name' | 'summary';
  }) {
    // Only filters ArgoCD's ApplicationQuery actually supports are sent
    // upstream. `search` is not one of them — the gRPC gateway silently drops
    // unknown params and returns everything — so it is applied client-side.
    const queryParams: Record<string, string | string[]> = {};
    if (params?.projects?.length) queryParams.projects = params.projects;
    if (params?.selector) queryParams.selector = params.selector;
    if (params?.repo) queryParams.repo = params.repo;

    const { body } = await this.client.get<V1alpha1ApplicationList>(
      `/api/v1/applications`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    let matched = body.items ?? [];
    if (params?.search) {
      const needle = params.search.toLowerCase();
      matched = matched.filter((app) => app.metadata?.name?.toLowerCase().includes(needle));
    }

    // Strip heavy fields to reduce token usage. status.sync is reduced to its
    // verdict: comparedTo embeds a second full copy of the source (inline Helm
    // values included).
    const strippedItems = matched.map((app) =>
      params?.detail === 'name'
        ? {
            name: app.metadata?.name,
            namespace: app.metadata?.namespace,
            project: app.spec?.project,
            syncStatus: app.status?.sync?.status,
            healthStatus: app.status?.health?.status
          }
        : {
            metadata: {
              name: app.metadata?.name,
              namespace: app.metadata?.namespace,
              labels: app.metadata?.labels,
              creationTimestamp: app.metadata?.creationTimestamp
            },
            spec: {
              project: app.spec?.project,
              source: stripSource(app.spec?.source),
              sources: app.spec?.sources?.map((source) => stripSource(source)),
              destination: app.spec?.destination
            },
            status: {
              sync: app.status?.sync && {
                status: app.status.sync.status,
                revision: app.status.sync.revision,
                revisions: app.status.sync.revisions
              },
              health: app.status?.health,
              summary: app.status?.summary
            }
          }
    );

    // Apply pagination. totalItems counts applications after filtering (search/
    // projects/selector/repo), not the whole instance.
    const start = params?.offset ?? 0;
    const end = start + (params?.limit ?? DEFAULT_LIST_LIMIT);
    const items = strippedItems.slice(start, end);

    return {
      items,
      metadata: {
        resourceVersion: body.metadata?.resourceVersion,
        totalItems: strippedItems.length,
        returnedItems: items.length,
        hasMore: end < strippedItems.length
      }
    };
  }

  public async listClusters(params?: { server?: string; name?: string }) {
    const queryParams: Record<string, string> = {};
    if (params?.server) queryParams.server = params.server;
    if (params?.name) queryParams.name = params.name;

    const { body } = await this.client.get<V1alpha1ClusterList>(
      `/api/v1/clusters`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    // info.apiVersions alone can be >90% of the raw payload; config carries
    // connection/TLS material. Neither belongs in a listing.
    const items =
      body.items?.map((cluster) => ({
        name: cluster.name,
        server: cluster.server,
        labels: cluster.labels,
        annotations: cluster.annotations,
        namespaces: cluster.namespaces,
        project: cluster.project,
        clusterResources: cluster.clusterResources,
        connectionState: cluster.connectionState,
        info: cluster.info && {
          applicationsCount: cluster.info.applicationsCount,
          serverVersion: cluster.info.serverVersion,
          connectionState: cluster.info.connectionState,
          cacheInfo: cluster.info.cacheInfo
        }
      })) ?? [];

    return { items, metadata: body.metadata };
  }

  public async getApplication(
    applicationName: string,
    appNamespace?: string,
    options?: { includeHistory?: boolean; includeOperationState?: boolean }
  ) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      queryParams
    );

    // The fields dropped here dominate a raw Application payload without
    // carrying current state: managedFields is server bookkeeping, history and
    // operationState replay past syncs, and sync.comparedTo embeds a second
    // full copy of the source (inline Helm values included). spec is returned
    // untouched. JSON serialization drops the undefined keys.
    return {
      ...body,
      metadata: body.metadata && { ...body.metadata, managedFields: undefined },
      status: body.status && {
        ...body.status,
        history: options?.includeHistory ? body.status.history : undefined,
        operationState: options?.includeOperationState
          ? body.status.operationState
          : body.status.operationState && {
              phase: body.status.operationState.phase,
              message: body.status.operationState.message,
              startedAt: body.status.operationState.startedAt,
              finishedAt: body.status.operationState.finishedAt,
              retryCount: body.status.operationState.retryCount
            },
        sync: body.status.sync && { ...body.status.sync, comparedTo: undefined }
      }
    };
  }

  public async getAppProject(projectName: string) {
    const { body } = await this.client.get<V1alpha1AppProject>(`/api/v1/projects/${projectName}`);
    return body;
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
