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

export const HelmOverridesSchema = z
  .object({
    parameters: z
      .array(
        z.object({
          name: z.string().min(1).describe('Helm parameter name, e.g. "image.tag".'),
          value: z.string().describe('Helm parameter value.'),
          forceString: z
            .boolean()
            .optional()
            .describe('Tell Helm to interpret booleans and numbers as strings.')
        })
      )
      .optional()
      .describe(
        'Helm parameters to upsert, matched by name. Existing parameters not listed are kept.'
      ),
    fileParameters: z
      .array(
        z.object({
          name: z.string().min(1).describe('Helm file parameter name.'),
          path: z.string().min(1).describe('Path to the file holding the value.')
        })
      )
      .optional()
      .describe('Helm file parameters to upsert, matched by name.'),
    valueFiles: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Value files to add. Appended if absent, preserving existing order; later files take precedence in Helm. To reorder or replace the list, unset the existing entries and set the full desired order in the same call.'
      ),
    values: z
      .string()
      .optional()
      .describe('Inline Helm values as a YAML string. Replaces any existing value.'),
    valuesObject: z
      .record(z.unknown())
      .optional()
      .describe(
        'Inline Helm values as an object. Replaces any existing value. Cannot be combined with "values".'
      )
  })
  .refine((v) => !(v.values !== undefined && v.valuesObject !== undefined), {
    message:
      'Set either values or valuesObject, not both: Argo CD lets valuesObject take precedence over values, so one of the two would be silently ignored.'
  });

export const KustomizeOverridesSchema = z.object({
  images: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Kustomize image overrides to upsert, e.g. "nginx:1.2", "old=new:tag", "nginx@sha256:...". Matched on the name before the first of "=", ":", "@" occurring anywhere, in that priority order — so "nginx@sha256:abc" is matched on "nginx@sha256", meaning a digest override is added alongside a tagged entry for the same repository rather than replacing it, and with no "=" present, "localhost:5000/nginx:1.2" is matched on "localhost".'
    ),
  replicas: z
    .array(
      z.object({
        name: z.string().min(1).describe('Name of the resource to scale.'),
        count: z
          .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
          .describe(
            'Replica count, as a non-negative integer or a string containing one, e.g. 3 or "3". Argo CD parses the string form with strconv.Atoi, and Kubernetes rejects a negative replica count, so neither a non-numeric nor a negative value is accepted.'
          )
      })
    )
    .optional()
    .describe('Kustomize replica overrides to upsert, matched by name.'),
  namePrefix: z.string().optional().describe('Prefix applied to rendered resource names.'),
  nameSuffix: z.string().optional().describe('Suffix applied to rendered resource names.'),
  commonLabels: z
    .record(z.string())
    .optional()
    .describe(
      'Labels to merge into rendered manifests, by key. Existing keys not listed are kept.'
    ),
  commonAnnotations: z
    .record(z.string())
    .optional()
    .describe(
      'Annotations to merge into rendered manifests, by key. Existing keys not listed are kept.'
    )
});

export const ParameterUnsetSchema = z.object({
  helm: z
    .object({
      parameters: z.array(z.string().min(1)).optional().describe('Helm parameter names to remove.'),
      fileParameters: z
        .array(z.string().min(1))
        .optional()
        .describe('Helm file parameter names to remove.'),
      valueFiles: z
        .array(z.string().min(1))
        .optional()
        .describe('Value file paths to remove, matched exactly.'),
      values: z.boolean().optional().describe('true removes the inline values string.'),
      valuesObject: z.boolean().optional().describe('true removes the inline values object.')
    })
    .optional(),
  kustomize: z
    .object({
      images: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Image names to remove, e.g. "nginx" for "nginx:1.2". The name is everything before the first of "=", ":", "@" that occurs anywhere in the entry, tried in that priority order — so a digest entry "nginx@sha256:abc" is removed by passing "nginx@sha256", and "localhost:5000/nginx:1.2" by passing "localhost". A name that matches nothing is silently ignored.'
        ),
      replicas: z.array(z.string().min(1)).optional().describe('Replica names to remove.'),
      namePrefix: z.boolean().optional().describe('true removes namePrefix.'),
      nameSuffix: z.boolean().optional().describe('true removes nameSuffix.'),
      commonLabels: z.array(z.string().min(1)).optional().describe('Label keys to remove.'),
      commonAnnotations: z
        .array(z.string().min(1))
        .optional()
        .describe('Annotation keys to remove.')
    })
    .optional()
});
