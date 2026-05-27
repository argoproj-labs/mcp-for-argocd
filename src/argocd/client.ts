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
  V1alpha1ClusterList
} from '../types/argocd-types.js';
import { HttpClient } from './http.js';

export class ArgoCDClient {
  private static readonly TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Error']);

  private baseUrl: string;
  private apiToken: string;
  private client: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.client = new HttpClient(this.baseUrl, this.apiToken);
  }

  private async fetchApplicationList(search?: string) {
    const { body } = await this.client.get<V1alpha1ApplicationList>(
      `/api/v1/applications`,
      search ? { search } : undefined
    );
    return body;
  }

  private stripApplicationFields(app: V1alpha1Application) {
    return {
      metadata: {
        name: app.metadata?.name,
        namespace: app.metadata?.namespace,
        labels: app.metadata?.labels,
        creationTimestamp: app.metadata?.creationTimestamp
      },
      spec: {
        project: app.spec?.project,
        source: app.spec?.source,
        destination: app.spec?.destination
      },
      status: {
        sync: app.status?.sync,
        health: app.status?.health,
        summary: app.status?.summary
      }
    };
  }

  private parseTimestamp(value?: string) {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed;
  }

  private getLastSyncAt(app: V1alpha1Application) {
    const candidates: Date[] = [];

    const operationState = app.status?.operationState;
    const operationFinishedAt = this.parseTimestamp(operationState?.finishedAt);
    if (operationFinishedAt) {
      candidates.push(operationFinishedAt);
    }

    if (operationState?.phase && !ArgoCDClient.TERMINAL_PHASES.has(operationState.phase)) {
      const operationStartedAt = this.parseTimestamp(operationState?.startedAt);
      if (operationStartedAt) {
        candidates.push(operationStartedAt);
      }
    }

    for (const historyItem of app.status?.history ?? []) {
      const deployedAt = this.parseTimestamp(historyItem.deployedAt);
      if (deployedAt) {
        candidates.push(deployedAt);
      }

      const deployStartedAt = this.parseTimestamp(historyItem.deployStartedAt);
      if (deployStartedAt) {
        candidates.push(deployStartedAt);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    return candidates.reduce((latest, current) =>
      current.getTime() > latest.getTime() ? current : latest
    );
  }

  public async listApplications(params?: {
    search?: string;
    limit?: number;
    offset?: number;
    changedWithinMinutes?: number;
  }) {
    const body = await this.fetchApplicationList(params?.search);

    if (params?.changedWithinMinutes !== undefined) {
      const cutoffDate = new Date(Date.now() - params.changedWithinMinutes * 60 * 1000);

      const filteredItems =
        body.items
          ?.map((app) => {
            const lastSyncAt = this.getLastSyncAt(app);
            if (!lastSyncAt || lastSyncAt.getTime() < cutoffDate.getTime()) {
              return null;
            }

            return {
              ...this.stripApplicationFields(app),
              lastSyncAt: lastSyncAt.toISOString()
            };
          })
          .filter((app): app is NonNullable<typeof app> => app !== null)
          .sort(
            (a, b) => new Date(b.lastSyncAt).getTime() - new Date(a.lastSyncAt).getTime()
          ) ?? [];

      const start = params.offset ?? 0;
      const end = params.limit ? start + params.limit : filteredItems.length;
      const items = filteredItems.slice(start, end);

      return {
        items,
        metadata: {
          resourceVersion: body.metadata?.resourceVersion,
          changedWithinMinutes: params.changedWithinMinutes,
          cutoffTime: cutoffDate.toISOString(),
          totalItems: filteredItems.length,
          returnedItems: items.length,
          hasMore: end < filteredItems.length
        }
      };
    }

    // Strip heavy fields to reduce token usage
    const strippedItems = body.items?.map((app) => this.stripApplicationFields(app)) ?? [];

    // Apply pagination
    const start = params?.offset ?? 0;
    const end = params?.limit ? start + params.limit : strippedItems.length;
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

    return body;
  }

  public async getApplication(applicationName: string, appNamespace?: string) {
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1Application>(
      `/api/v1/applications/${applicationName}`,
      queryParams
    );
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
