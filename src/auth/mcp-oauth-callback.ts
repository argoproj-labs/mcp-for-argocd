import { Router } from 'express';
import type { ArgocdOAuthProvider } from './mcp-oauth-provider.js';
import { logger } from '../logging/logging.js';

/**
 * Express router for the /callback endpoint.
 * ArgoCD's OIDC provider redirects here after user authenticates.
 */
export function createCallbackRouter(provider: ArgocdOAuthProvider): Router {
  const router = Router();

  router.get('/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;
    const errorDescription = req.query.error_description as string | undefined;

    if (error) {
      logger.error({ error, errorDescription }, 'Upstream OIDC authentication failed');
      res.status(400).send(`Authentication failed: ${errorDescription || error}`);
      return;
    }

    if (!code || !state) {
      res.status(400).send('Missing code or state parameter');
      return;
    }

    try {
      const redirectUrl = await provider.handleUpstreamCallback(code, state);
      res.redirect(redirectUrl);
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to handle upstream callback'
      );
      res.status(500).send('Authentication callback failed. Please try again.');
    }
  });

  return router;
}
