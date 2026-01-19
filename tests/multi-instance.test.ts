import { describe, it, expect } from 'vitest';
import { parseArgoCDConfig } from '../src/config/index.js';
import { createServer } from '../src/server/server.js';

describe('Multi-instance ArgoCD support', () => {
  it('should parse single instance from environment variables', () => {
    const config = parseArgoCDConfig(
      'https://argocd.example.com',
      'test-token'
    );

    expect(config.instances).toHaveLength(1);
    expect(config.instances[0].id).toBe('default');
    expect(config.instances[0].baseUrl).toBe('https://argocd.example.com');
    expect(config.defaultInstanceId).toBe('default');
  });

  it('should parse multiple instances from JSON', () => {
    const configJson = JSON.stringify({
      instances: [
        { id: 'prod', baseUrl: 'https://prod.example.com', apiToken: 'prod-token' },
        { id: 'staging', baseUrl: 'https://staging.example.com', apiToken: 'staging-token' }
      ],
      defaultInstanceId: 'prod'
    });

    const config = parseArgoCDConfig(undefined, undefined, configJson);

    expect(config.instances).toHaveLength(2);
    expect(config.instances[0].id).toBe('prod');
    expect(config.instances[1].id).toBe('staging');
    expect(config.defaultInstanceId).toBe('prod');
  });

  it('should throw error when no configuration provided', () => {
    expect(() => parseArgoCDConfig()).toThrow();
  });

  it('should create server with multiple instances', () => {
    const config = parseArgoCDConfig(
      undefined,
      undefined,
      JSON.stringify({
        instances: [
          { id: 'test1', baseUrl: 'https://test1.com', apiToken: 'token1' },
          { id: 'test2', baseUrl: 'https://test2.com', apiToken: 'token2' }
        ]
      })
    );

    const server = createServer({ argocdConfig: config });
    expect(server).toBeDefined();
  });
});
