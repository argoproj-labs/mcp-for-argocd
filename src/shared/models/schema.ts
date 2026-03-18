import { z } from 'zod';

export const ApplicationNamespaceSchema = z
  .string()
  .min(1)
  .describe(
    `The namespace where the ArgoCD application resource will be created.
     This is the namespace of the Application resource itself, not the destination namespace for the application's resources.
     You can specify any valid Kubernetes namespace (e.g., 'argocd', 'argocd-apps', 'my-namespace', etc.).
     The default ArgoCD namespace is typically 'argocd', but you can use any namespace you prefer.`
  );

export const ResourceRefSchema = z.object({
  uid: z.string(),
  kind: z.string(),
  namespace: z.string(),
  name: z.string(),
  version: z.string(),
  group: z.string()
});

/** Helm parameter passed to helm template (--set). */
const HelmParameterSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  forceString: z.boolean().optional()
});

/** Helm file parameter passed to helm template (--set-file). */
const HelmFileParameterSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional()
});

/** Helm-specific options for the application source (valueFiles, parameters, releaseName, etc.). */
export const ApplicationSourceHelmSchema = z
  .object({
    valueFiles: z.array(z.string()).optional().describe('Helm value files, e.g. ["values.yaml", "env/prod.yaml"]'),
    parameters: z.array(HelmParameterSchema).optional().describe('Helm --set parameters'),
    fileParameters: z.array(HelmFileParameterSchema).optional().describe('Helm --set-file parameters'),
    releaseName: z.string().optional().describe('Helm release name; defaults to application name'),
    values: z.string().optional().describe('Inline YAML values for helm template'),
    ignoreMissingValueFiles: z.boolean().optional(),
    skipCrds: z.boolean().optional(),
    skipTests: z.boolean().optional(),
    passCredentials: z.boolean().optional()
  })
  .optional();

export const ApplicationSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: ApplicationNamespaceSchema
  }),
  spec: z.object({
    project: z.string(),
    source: z.object({
      repoURL: z.string(),
      path: z.string(),
      targetRevision: z.string(),
      helm: ApplicationSourceHelmSchema
    }),
    syncPolicy: z.object({
      syncOptions: z.array(z.string()),
      automated: z.object({
        prune: z.boolean(),
        selfHeal: z.boolean()
      }).optional(),
      retry: z
        .object({
          limit: z.number(),
          backoff: z.object({
            duration: z.string(),
            maxDuration: z.string(),
            factor: z.number()
          })
        })
        .optional()
    }),
    destination: z.object({
      server: z.string().optional(),
      namespace: z.string().optional(),
      name: z.string().optional()
    })
      .refine(
        (data: { server?: string; name?: string }) =>
          (!data.server && !!data.name) || (!!data.server && !data.name),
        {
          message: "Only one of server or name must be specified in destination"
        }
      )
      .describe(
        `The destination of the application.
         Only one of server or name must be specified.`
      )
  })
});
