import { NextFunction, Request, RequestHandler, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { logger } from '../logging/logging.js';

// Opt-in verification of a JWT on every inbound MCP request. Intended for
// deployments behind an identity-aware proxy (Cloudflare Access, Google IAP,
// oauth2-proxy, ...) that authenticates the user at the edge and forwards a
// signed identity assertion in a header.

export type AuthConfig = {
  jwksUrl: string;
  issuer: string;
  audience: string;
  header: string;
};

// Clock-skew tolerance in seconds.
const CLOCK_TOLERANCE = 10;

// Read the auth config from the environment. All vars set: auth is enforced.
// None set: no auth. Partially set: throws an error, so a half-configured
// deployment fails at startup instead of silently running unauthenticated.
export const authConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AuthConfig | null => {
  const jwksUrl = env.MCP_AUTH_JWKS_URL?.trim() || '';
  const issuer = env.MCP_AUTH_ISSUER?.trim() || '';
  const audience = env.MCP_AUTH_AUDIENCE?.trim() || '';
  const header = (env.MCP_AUTH_TOKEN_HEADER?.trim() || 'authorization').toLowerCase();

  if (!jwksUrl && !issuer && !audience) return null;

  const missing = [
    ['MCP_AUTH_JWKS_URL', jwksUrl],
    ['MCP_AUTH_ISSUER', issuer],
    ['MCP_AUTH_AUDIENCE', audience]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Incomplete inbound auth config: missing ${missing.join(', ')}`);
  }

  return { jwksUrl, issuer, audience, header };
};

const extractToken = (req: Request, header: string): string => {
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return '';
  return header === 'authorization' ? value.replace(/^Bearer\s+/i, '') : value;
};

export const createAuthMiddleware = (
  config: AuthConfig,
  getKey?: JWTVerifyGetKey
): RequestHandler => {
  const keySource = getKey ?? createRemoteJWKSet(new URL(config.jwksUrl));

  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req, config.header);
    if (!token) {
      res.status(401).send(`Unauthorized: missing token in "${config.header}" header`);
      return;
    }

    try {
      const { payload } = await jwtVerify(token, keySource, {
        issuer: config.issuer,
        audience: config.audience,
        // RS256: Cloudflare Access, oauth2-proxy. ES256: Google IAP.
        algorithms: ['RS256', 'ES256'],
        clockTolerance: CLOCK_TOLERANCE,
        requiredClaims: ['exp']
      });
      logger.debug(
        `authenticated request: ${payload.email ?? payload.sub ?? 'unknown'} ${req.method} ${req.path}`
      );
      next();
    } catch (error) {
      logger.warn(
        `rejected inbound token: ${error instanceof Error ? error.name : 'unknown error'}`
      );
      res.status(401).send('Unauthorized: invalid token');
    }
  };
};
