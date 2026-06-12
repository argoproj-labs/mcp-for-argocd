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
      targetRevision: z.string()
    }),
    syncPolicy: z.object({
      syncOptions: z.array(z.string()),
      automated: z
        .object({
          prune: z.boolean(),
          selfHeal: z.boolean()
        })
        .optional(),
      retry: z.object({
        limit: z.number(),
        backoff: z.object({
          duration: z.string(),
          maxDuration: z.string(),
          factor: z.number()
        })
      })
    }),
    destination: z
      .object({
        server: z.string().optional(),
        namespace: z.string().optional(),
        name: z.string().optional()
      })
      .refine(
        (data: { server?: string; name?: string }) =>
          (!data.server && !!data.name) || (!!data.server && !data.name),
        {
          message: 'Only one of server or name must be specified in destination'
        }
      )
      .describe(
        `The destination of the application.
         Only one of server or name must be specified.`
      )
  })
});
