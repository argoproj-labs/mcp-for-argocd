import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { logger } from '../logging/logging.js';

// Loopback names, in the bracketed form the Host header and the SDK's
// hostHeaderValidation use for IPv6.
export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// The MCP Streamable HTTP spec recommends loopback-only for local servers.
export const DEFAULT_BIND_ADDRESS = '127.0.0.1';

// Wildcard binds. Not names a client can send in a Host header, so they never
// enter an allow list.
const WILDCARD_BIND_ADDRESSES = ['0.0.0.0', '::', '[::]'];

// A bind address never carries a port, so a colon means IPv6.
const bracketIfIpv6 = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

// All of 127.0.0.0/8 is loopback (RFC 5735). normalizeHostname has already
// canonicalized every parseable IPv4 spelling to dotted decimal by this point.
const isLoopbackIpv4 = (hostname: string): boolean => /^127(\.\d{1,3}){3}$/.test(hostname);

export const isLoopbackAddress = (address: string): boolean => {
  const hostname = normalizeHostname(bracketIfIpv6(address.toLowerCase()));
  return hostname !== null && (LOOPBACK_HOSTNAMES.includes(hostname) || isLoopbackIpv4(hostname));
};

// A DNS label. Narrower than the WHATWG URL host parser, which also accepts
// '*', ',', '$', '{' and '}'.
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Reject names the OS resolver and the WHATWG URL parser could read differently.
// WHATWG reads 'evil.example@127.0.0.1' as userinfo plus a loopback host, and
// '0177.0.0.1' as octal for 127.0.0.1 where getaddrinfo gives 177.0.0.1. The
// loopback decision uses one parser and the socket bind uses the other.
const isUsableHostname = (hostname: string): boolean => {
  const bare = normalizeBindAddress(hostname);
  if (bare !== hostname) return net.isIPv6(bare);
  if (net.isIP(hostname)) return true;
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  // An all-digit final label is a mistyped IP ('0177.0.0.1', '127.1'). DNS
  // forbids a numeric TLD, so no legitimate name has this shape.
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  return labels.every((label) => HOSTNAME_LABEL.test(label));
};

// Canonicalize a bind address before anything decides whether it is loopback.
export const canonicalizeBindAddress = (address: string): string => {
  const canonical = address.trim().toLowerCase();
  if (!canonical || !isUsableHostname(canonical)) {
    throw new Error(
      `Invalid --bind-address value: ${address}. Expected an IP address or a hostname, e.g. ` +
        `${DEFAULT_BIND_ADDRESS}, 0.0.0.0, [::1], or mcp.internal.example.com.`
    );
  }
  return canonical;
};

// net.listen() takes a bare address ('::1'); Host headers use the bracketed form.
export const normalizeBindAddress = (address: string): string =>
  address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;

// Reduce a hostname, host:port, or origin to its hostname, keeping the brackets
// WHATWG URL preserves around IPv6 so the result matches a LOOPBACK_HOSTNAMES entry.
const normalizeHostname = (value: string): string | null => {
  const candidate = value.includes('://') ? value : `http://${value}`;
  try {
    return new URL(candidate).hostname || null;
  } catch {
    return null;
  }
};

// Same policy as canonicalizeBindAddress, applied to an allow-list entry: reject
// anything the URL parser would rewrite rather than store a name the operator
// never wrote. A Host header is an authority, so compare the raw authority alone
// and refuse a path, query, or fragment. Comparing the whole value would let the
// rewrite back in: '0177.0.0.1/127.0.0.1' has the authority 0177.0.0.1.
const strictHostname = (value: string): string | null => {
  const candidate = value.includes('://') ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password || !url.hostname) return null;
  const afterScheme = candidate.slice(candidate.indexOf('://') + 3);
  const authority = afterScheme.split(/[/?#]/)[0];
  if (authority !== afterScheme) return null;
  // url.hostname is lower-cased already. The port pattern cannot match inside a
  // bracketed IPv6 literal, which ends in ']'.
  const rawHost = authority.replace(/:\d*$/, '').toLowerCase();
  return rawHost === url.hostname ? url.hostname : null;
};

// The Host allow list: loopback names, the bind address itself, and operator
// entries. Throws on an unusable entry, since the URL host parser accepts '*', a
// comma-joined list, and an unexpanded '${VAR}', none of which a request can match.
export const resolveAllowedHostnames = (
  bindAddress: string,
  allowedHostHeaders: string[] = []
): string[] => {
  const names = new Set(LOOPBACK_HOSTNAMES);
  for (const value of allowedHostHeaders) {
    const hostname = strictHostname(value);
    if (!hostname || !isUsableHostname(hostname)) {
      throw new Error(
        `Invalid --allowed-host-header value: ${value}. Expected a single hostname, host:port, or ` +
          'origin. Wrap an IPv6 literal in brackets, e.g. [::1]. There is no wildcard: repeat ' +
          '--allowed-host-header for each name, and omit it entirely to accept any Host.'
      );
    }
    names.add(hostname);
  }
  if (!WILDCARD_BIND_ADDRESSES.includes(bindAddress)) {
    const hostname = normalizeHostname(bracketIfIpv6(bindAddress));
    if (hostname) names.add(hostname);
  }
  return [...names];
};

// The Origin allow list. Unlike Host these are full origins: scheme and port are
// part of the browser's origin boundary, so a co-resident dev server on another
// port is not a match.
export const resolveAllowedOrigins = (port: number, allowedOrigins: string[] = []): string[] => {
  const origins = new Set<string>();
  // How a page served by this listener over loopback addresses it. https covers
  // reaching it through a TLS proxy.
  for (const hostname of LOOPBACK_HOSTNAMES) {
    for (const scheme of ['http', 'https']) {
      origins.add(new URL(`${scheme}://${hostname}:${port}`).origin);
    }
  }
  for (const value of allowedOrigins) {
    // 'null' is the opaque-origin sentinel for a sandboxed iframe or file:// page.
    // Allow-listing it would admit every such context at once.
    if (value.trim().toLowerCase() === 'null') {
      throw new Error(
        `Invalid --allowed-origin value: ${value}. "null" is what a browser sends for any ` +
          'sandboxed or file:// context and cannot be allowed.'
      );
    }
    const origin = canonicalOrigin(value.includes('://') ? value : `https://${value}`);
    if (!origin) {
      throw new Error(
        `Invalid --allowed-origin value: ${value}. Expected an origin such as ` +
          'https://ide.example or vscode-webview://<id>.'
      );
    }
    origins.add(origin);
  }
  return [...origins];
};

// URL.origin serializes to 'null' for every non-special scheme, so clients that
// legitimately send one (vscode-webview://, chrome-extension://) are matched on
// scheme plus host. An opaque host is a client-generated id rather than a DNS
// name, but must still be a single token.
const OPAQUE_HOST = /^[a-z0-9][a-z0-9._-]*$/;

const canonicalOrigin = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Parsing is not enough: 'https://a.example,https://b.example' serializes to
  // the origin 'https://a.example,https', and 'https://*' to the host '*'.
  if (url.origin !== 'null') return isUsableHostname(url.hostname) ? url.origin : null;
  if (!url.host || !OPAQUE_HOST.test(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
};

const jsonRpcError = (res: express.Response, status: number, message: string): void => {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null
  });
};

// Reject cross-origin requests, the half of DNS-rebinding protection the SDK's
// hostHeaderValidation does not cover. Only requests carrying an Origin are
// checked; a browser omits it on a same-origin GET, and a rebound page believes
// it is same-origin, so Host validation is what covers that case.
export const originValidation = (allowedOrigins: string[]): express.RequestHandler => {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const normalized = origin.toLowerCase() === 'null' ? null : canonicalOrigin(origin);
    if (!normalized || !allowedOrigins.includes(normalized)) {
      jsonRpcError(
        res,
        403,
        `Invalid Origin: ${origin}. Pass --allowed-origin to accept it; note that scheme and ` +
          'port are part of an origin, so a proxy or a published container port changes it.'
      );
      return;
    }
    next();
  };
};

// Hashing first gives timingSafeEqual the equal-length buffers it requires, so a
// wrong-length guess is indistinguishable from a wrong-value one.
const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const secretsMatch = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

// The inbound credential, separate from ARGOCD_API_TOKEN. That one is outbound,
// used to call ArgoCD, and says nothing about who the caller is.
export const bearerAuth = (expectedToken: string): express.RequestHandler => {
  return (req, res, next) => {
    // RFC 9110: the scheme is case-insensitive and any amount of whitespace may
    // follow it, so parse rather than match a literal 'Bearer '.
    const [scheme, ...rest] = (req.headers.authorization ?? '').trim().split(/\s+/);
    const presented = rest.length === 1 ? rest[0] : undefined;
    if (
      scheme?.toLowerCase() !== 'bearer' ||
      !presented ||
      !secretsMatch(presented, expectedToken)
    ) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      jsonRpcError(res, 401, 'Missing or invalid inbound bearer token');
      return;
    }
    next();
  };
};

export type ListenerSecurity = {
  // Bind address in the bare form net.listen() accepts.
  bindAddress: string;
  allowedHostnames: string[];
  allowedOrigins: string[];
  authToken?: string;
  // Host validation only makes sense for a loopback bind or an operator-supplied
  // allow list. On an exposed bind with no list, the name clients legitimately
  // use is unknown.
  validateHostHeader: boolean;
};

export type ListenerSecurityOptions = {
  bindAddress?: string;
  port: number;
  allowedHostHeaders?: string[];
  allowedOrigins?: string[];
  authToken?: string;
  allowUnauthenticated?: boolean;
};

// Validate a listener's exposure before anything binds a socket. Throws rather
// than warning: a bind past loopback puts every MCP tool in reach of anything
// that can route here.
export const resolveListenerSecurity = (options: ListenerSecurityOptions): ListenerSecurity => {
  const bindAddress = canonicalizeBindAddress(options.bindAddress || DEFAULT_BIND_ADDRESS);

  // A set-but-empty token is a broken config (an unexpanded '${VAR}', a k8s secret
  // key that resolved to nothing), not a request to run without authentication.
  if (options.authToken !== undefined && options.authToken.trim() === '') {
    throw new Error(
      'MCP_AUTH_TOKEN is set but empty. Give it a value to require an inbound bearer token, ' +
        'or unset it entirely.'
    );
  }
  // Surrounding whitespace comes from how the secret was delivered ($(cat token),
  // a k8s --from-file secret) and is stripped. Whitespace inside is fatal: RFC 6750
  // token68 has no room for it and CR/LF cannot appear in a header at all, so such
  // a token could never be presented.
  const authToken = options.authToken?.trim();
  if (authToken !== undefined && /\s/.test(authToken)) {
    throw new Error(
      'MCP_AUTH_TOKEN contains whitespace, which cannot be sent in an Authorization header. ' +
        'Use a token of printable non-space characters, e.g. `openssl rand -hex 32`.'
    );
  }

  if (!isLoopbackAddress(bindAddress) && !authToken && !options.allowUnauthenticated) {
    throw new Error(
      `Refusing to bind to ${bindAddress} without inbound authentication. The MCP listener exposes ` +
        'every ArgoCD tool to anything that can reach it, and ARGOCD_API_TOKEN authenticates ' +
        'this server to ArgoCD, not the caller. Either set MCP_AUTH_TOKEN to require an inbound ' +
        '"Authorization: Bearer <token>" header, or pass --allow-unauthenticated if the listener ' +
        'is already protected by an external layer (a sidecar proxy, service mesh, or network ' +
        `policy). To listen locally only, set --bind-address to ${DEFAULT_BIND_ADDRESS}.`
    );
  }

  return {
    bindAddress: normalizeBindAddress(bindAddress),
    allowedHostnames: resolveAllowedHostnames(bindAddress, options.allowedHostHeaders),
    allowedOrigins: resolveAllowedOrigins(options.port, options.allowedOrigins),
    authToken,
    validateHostHeader:
      isLoopbackAddress(bindAddress) || (options.allowedHostHeaders?.length ?? 0) > 0
  };
};

// Guard every route registered after this call.
export const applyListenerSecurity = (app: express.Express, security: ListenerSecurity): void => {
  // A setting, not middleware, so it also covers /healthz registered before this.
  app.disable('x-powered-by');
  // The credential runs first. Last, it would answer 403 for a Host or Origin
  // outside the allow list and 401 for one inside it, which is enough to
  // enumerate the allow lists without presenting a token.
  if (security.authToken) app.use(bearerAuth(security.authToken));
  if (security.validateHostHeader) {
    app.use(hostHeaderValidation(security.allowedHostnames));
  } else {
    logger.warn(
      `Host header validation is disabled because the listener binds ${security.bindAddress} with no ` +
        '--allowed-host-header entries. Pass --allowed-host-header <hostname> for each name clients use to ' +
        'reach this server to enable it.'
    );
  }
  app.use(originValidation(security.allowedOrigins));
  warnIfUnauthenticatedAndExposed(security);
};

// --allow-unauthenticated is the one setting that leaves the listener open. It is
// legitimate behind a proxy or mesh, but an operator who later removes that layer
// has nothing else to remind them.
const warnIfUnauthenticatedAndExposed = (security: ListenerSecurity): void => {
  if (security.authToken || isLoopbackAddress(security.bindAddress)) return;
  logger.warn(
    `The listener binds ${security.bindAddress} with no inbound authentication (--allow-unauthenticated). ` +
      'Every ArgoCD tool, including create/update/delete/sync_application and ' +
      'run_resource_action, is callable by anything that can reach this address. This is only ' +
      'safe behind an external layer that authenticates callers (sidecar proxy, service mesh, ' +
      'network policy). Set MCP_AUTH_TOKEN to require a bearer token here instead, and consider ' +
      'MCP_READ_ONLY=true to unregister the write tools.'
  );
};
