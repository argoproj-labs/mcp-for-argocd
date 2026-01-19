import { z } from 'zod';

/**
 * Schema for a single ArgoCD instance configuration
 */
export const ArgoCDInstanceConfigSchema = z.object({
  id: z.string().min(1).describe('Unique identifier for this ArgoCD instance'),
  baseUrl: z.string().url().describe('Base URL of the ArgoCD API'),
  apiToken: z.string().min(1).describe('API token for authentication'),
  description: z.string().optional().describe('Optional description of this instance')
});

export type ArgoCDInstanceConfig = z.infer<typeof ArgoCDInstanceConfigSchema>;

/**
 * Schema for multiple ArgoCD instances configuration
 */
export const ArgoCDConfigSchema = z.object({
  instances: z.array(ArgoCDInstanceConfigSchema).min(1),
  defaultInstanceId: z.string().optional().describe('Default instance ID to use when not specified')
});

export type ArgoCDConfig = z.infer<typeof ArgoCDConfigSchema>;

/**
 * Parse ArgoCD configuration from environment variables or config object
 */
export function parseArgoCDConfig(
  envBaseUrl?: string,
  envApiToken?: string,
  configJson?: string
): ArgoCDConfig {
  // If configJson is provided, parse and validate it
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      return ArgoCDConfigSchema.parse(parsed);
    } catch (error) {
      throw new Error(
        `Failed to parse ArgoCD configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Otherwise, create single instance from environment variables
  if (!envBaseUrl || !envApiToken) {
    throw new Error('ARGOCD_BASE_URL and ARGOCD_API_TOKEN must be provided');
  }

  return {
    instances: [
      {
        id: 'default',
        baseUrl: envBaseUrl,
        apiToken: envApiToken,
        description: 'Default ArgoCD instance from environment variables'
      }
    ],
    defaultInstanceId: 'default'
  };
}
