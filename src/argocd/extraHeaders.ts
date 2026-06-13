// Parse ARGOCD_EXTRA_HEADERS: a JSON object of header names to string values,
// e.g. {"Cookie": "x-og-token=..."}. Applied to every request to Argo CD.
export const parseExtraHeaders = (raw: string | undefined): Record<string, string> => {
  if (!raw?.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ARGOCD_EXTRA_HEADERS must be valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ARGOCD_EXTRA_HEADERS must be a JSON object');
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`ARGOCD_EXTRA_HEADERS: header "${key}" must be a string value`);
    }
    headers[key] = value;
  }
  return headers;
};

export const extraHeadersFromEnv = (
  raw: string | undefined = process.env.ARGOCD_EXTRA_HEADERS
): Record<string, string> => parseExtraHeaders(raw);
