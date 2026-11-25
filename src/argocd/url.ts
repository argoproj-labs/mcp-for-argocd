import { PathValidationError } from './errors.js';

// Strict Kubernetes / Argo CD resource segment pattern.
// Disallows path separators, traversal sequences, percent-encoding tricks, and whitespace.
const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;

export const encodePathSegment = (value: string, fieldName: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    !SAFE_PATH_SEGMENT_RE.test(value)
  ) {
    throw new PathValidationError(
      fieldName,
      `Invalid ${fieldName}: must match ${SAFE_PATH_SEGMENT_RE.source} and must not contain path traversal segments.`
    );
  }
  return encodeURIComponent(value);
};

export const normalizeBaseUrlPrefix = (baseUrl: string): { origin: string; basePath: string } => {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new PathValidationError('argocdBaseUrl', 'Argo CD base URL must not be empty.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PathValidationError('argocdBaseUrl', `Invalid Argo CD base URL: "${baseUrl}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PathValidationError(
      'argocdBaseUrl',
      `Unsupported protocol "${parsed.protocol}" in Argo CD base URL; expected http: or https:.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new PathValidationError(
      'argocdBaseUrl',
      'Argo CD base URL must not embed credentials in userinfo.'
    );
  }
  const basePath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return { origin: parsed.origin, basePath };
};

// Build a controlled Argo CD API URL that:
//   1. Preserves any reverse-proxy subpath configured in baseUrl (e.g. https://host/argocd)
//   2. Prevents origin or base-path escapes via relative path resolution
export const buildArgoCDUrl = (baseUrl: string, relativePath: string): URL => {
  const { origin, basePath } = normalizeBaseUrlPrefix(baseUrl);
  const cleanPath = relativePath.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..') || cleanPath.includes('\\')) {
    throw new PathValidationError('path', 'Invalid relative API path.');
  }
  const resolved = new URL(cleanPath, `${origin}${basePath}`);
  if (resolved.origin !== origin || !resolved.pathname.startsWith(basePath)) {
    throw new PathValidationError(
      'path',
      'Resolved Argo CD API URL escaped the configured base path.'
    );
  }
  return resolved;
};
