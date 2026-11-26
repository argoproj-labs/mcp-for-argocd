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
  V1alpha1AppProject
} from '../types/argocd-types.js';
import { HttpClient } from './http.js';
import { encodePathSegment } from './url.js';

export class ArgoCDClient {
  private baseUrl: string;
  private apiToken: string;
  private client: HttpClient;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.client = new HttpClient(this.baseUrl, this.apiToken);
  }

  public async listApplications(params?: { search?: string; limit?: number; offset?: number }) {
    const { body } = await this.client.get<V1alpha1ApplicationList>(
      'api/v1/applications',
      params?.search ? { search: params.search } : undefined
    );

    // Strip heavy fields to reduce token usage
    const strippedItems =
      body.items?.map((app) => ({
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
      })) ?? [];

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
      'api/v1/clusters',
      Object.keys(queryParams).length > 0 ? queryParams : undefined
    );

    return body;
  }

  public async getApplication(applicationName: string, appNamespace?: string) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1Application>(
      `api/v1/applications/${appSeg}`,
      queryParams
    );
    return body;
  }

  public async getAppProject(projectName: string) {
    const projectSeg = encodePathSegment(projectName, 'projectName');
    const { body } = await this.client.get<V1alpha1AppProject>(`api/v1/projects/${projectSeg}`);
    return body;
  }

  public async createApplication(application: V1alpha1Application) {
    const { body } = await this.client.post<V1alpha1Application, V1alpha1Application>(
      'api/v1/applications',
      null,
      application
    );
    return body;
  }

  public async updateApplication(applicationName: string, application: V1alpha1Application) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.put<V1alpha1Application, V1alpha1Application>(
      `api/v1/applications/${appSeg}`,
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
    const appSeg = encodePathSegment(applicationName, 'applicationName');
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
      `api/v1/applications/${appSeg}`,
      Object.keys(queryParams).length > 0 ? queryParams : undefined,
      { allowEmptyBody: true }
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
    const appSeg = encodePathSegment(applicationName, 'applicationName');
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
      `api/v1/applications/${appSeg}/sync`,
      null,
      Object.keys(syncRequest).length > 0 ? syncRequest : undefined
    );
    return body;
  }

  public async getApplicationResourceTree(applicationName: string, appNamespace?: string) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1alpha1ApplicationTree>(
      `api/v1/applications/${appSeg}/resource-tree`,
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
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<{ items: V1alpha1ResourceDiff[] }>(
      `api/v1/applications/${appSeg}/managed-resources`,
      filters
    );
    return body;
  }

  public async getApplicationLogs(applicationName: string) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `api/v1/applications/${appSeg}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => {
        logs.push(chunk);
      }
    );
    return logs;
  }

  public async getWorkloadLogs(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult,
    container: string
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `api/v1/applications/${appSeg}/logs`,
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
      (chunk) => {
        logs.push(chunk);
      }
    );
    return logs;
  }

  public async getPodLogs(applicationName: string, podName: string) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const podSeg = encodePathSegment(podName, 'podName');
    const logs: ApplicationLogEntry[] = [];
    await this.client.getStream<ApplicationLogEntry>(
      `api/v1/applications/${appSeg}/pods/${podSeg}/logs`,
      {
        follow: false,
        tailLines: 100
      },
      (chunk) => {
        logs.push(chunk);
      }
    );
    return logs;
  }

  public async getApplicationEvents(applicationName: string, appNamespace?: string) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const queryParams = appNamespace ? { appNamespace } : undefined;
    const { body } = await this.client.get<V1EventList>(
      `api/v1/applications/${appSeg}/events`,
      queryParams
    );
    return body;
  }

  public async getResource(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<V1alpha1ApplicationResourceResult>(
      `api/v1/applications/${appSeg}/resource`,
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
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<V1EventList>(`api/v1/applications/${appSeg}/events`, {
      appNamespace: applicationNamespace,
      resourceNamespace,
      resourceUID,
      resourceName
    });
    return body;
  }

  public async getResourceActions(
    applicationName: string,
    applicationNamespace: string,
    resourceRef: V1alpha1ResourceResult
  ) {
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.get<{ actions: V1alpha1ResourceAction[] }>(
      `api/v1/applications/${appSeg}/resource/actions`,
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
    const appSeg = encodePathSegment(applicationName, 'applicationName');
    const { body } = await this.client.post<string, V1alpha1Application>(
      `api/v1/applications/${appSeg}/resource/actions`,
      {
        appNamespace: applicationNamespace,
        namespace: resourceRef.namespace,
        resourceName: resourceRef.name,
        group: resourceRef.group,
        kind: resourceRef.kind,
        version: resourceRef.version
      },
      action,
      { allowEmptyBody: true }
    );
    return body;
  }
}
