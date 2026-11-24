# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for a suspected vulnerability.

To report one, create a draft GitHub security advisory:

https://github.com/argoproj-labs/mcp-for-argocd/security/advisories/new

This is the same process the [Argo CD project](https://github.com/argoproj/argo-cd/blob/master/SECURITY.md) uses. The advisory is private until we publish it, and it is where a CVE is requested and the fix is coordinated. Reports sent to individual maintainers or to any vendor's support channel will be redirected here, which only delays the fix.

Please include enough detail to reproduce the issue: the affected version, the configuration or transport involved (`stdio`, `http`, `sse`), and the steps or proof of concept.

We will do our best to respond quickly, though a reply may occasionally take longer (for example, out-of-office periods). We are happy to coordinate a disclosure timeline with you and to credit you in the advisory.

**Findings from automated scanners** are already public, so report those as a normal [GitHub issue](https://github.com/argoproj-labs/mcp-for-argocd/issues) — the discussion is usually of general benefit.

## Supported Versions

Fixes land on `main` and ship in the next release. Please confirm an issue against the latest release before reporting it.

## Operator Notes: Network Exposure

[Network Exposure](README.md#network-exposure) covers the settings. These are the parts that tend to surprise people.

- **The token gates the listener, not the caller.** `MCP_AUTH_TOKEN` is one shared secret, not a per-caller identity. Anyone holding it can call every registered tool and, with a [token registry](README.md#token-registry--per-base-url-tokens-multi-instance), target any base URL in it. For different reach per caller, run separate instances, each with its own token, registry entries, and [read-only mode](README.md#read-only-mode), or use [OAuth](README.md#oauth-single-sign-on), which calls ArgoCD as each user.
- **A proxy or a published port changes the `Origin`.** The allowed loopback origins use the port the server itself binds. Through `-p 8080:3000` or a TLS proxy the browser sends the origin it sees, so pass that to `--allowed-origin`. The `403` echoes the value it rejected.
- **Non-`http(s)` origins work, `null` does not.** `vscode-webview://<id>` and `chrome-extension://<id>` match as exact strings. The `null` a sandboxed or `file://` context sends is refused, since allowing it would admit every such context at once.
- **`Origin` alone is not enough on an exposed bind.** A browser omits `Origin` on a same-origin `GET`, and a DNS-rebound page believes it is same-origin. `Host` validation is what covers that, so pass `--allowed-host-header` or set `MCP_AUTH_TOKEN`. A proxy that forwards the client's original `Host` needs that name allow-listed too.
- **Browsers cannot call this server directly.** It sends no CORS headers, and `MCP_AUTH_TOKEN` cannot be attached to an `EventSource`. `--allowed-origin` only keeps *this* layer from rejecting a browser client that sits behind a CORS-terminating proxy.
- **Token whitespace.** Surrounding whitespace is stripped, since `$(cat token)` and `--from-file` secrets carry a trailing newline. Whitespace inside the token is a startup error, because such a token could never be sent in a header.
- **Bind address.** All of `127.0.0.0/8` counts as loopback, and IPv6 works with or without brackets. The default is IPv4 only, so a client insisting on `http://[::1]:3000` needs `--bind-address ::1`, or `::` for both stacks.
- **Loopback is reachable from a same-pod sidecar.** A published port (`docker run -p …`) is what does not reach a loopback listener; that needs an explicit wider bind.

## Operator Notes: OAuth

[OAuth](README.md#oauth-single-sign-on) covers the settings.

- **Revocation lags by up to one token lifetime.** Tokens are validated locally, by signature and expiry, not by asking the identity provider each time. A user who is deactivated or removed from ArgoCD's group keeps access until their current access token expires, and an exchanged ArgoCD token is reused for up to its own lifetime minus 30 seconds. Short-lived access tokens (minutes, not hours) keep that window small.
- **The exchange client must be public.** The exchange sends only `client_id`, no secret or client assertion, so a confidential client is refused; that includes Keycloak's standard token exchange, which requires client authentication. With a public client, anyone holding a valid access token for this server can exchange it themselves, for a token the same user could get by signing in to ArgoCD. Confidential-client support, which would close that at the cost of a secret on the server, is not implemented.
- **The metadata is public.** `/.well-known/oauth-protected-resource` names the issuer and nothing else, and is served without authentication, as clients read it before they sign in.
- **ID tokens are refused.** They carry the same issuer, audience and subject as access tokens, so the server requires the `scope` claim that only access tokens carry, and refuses Keycloak's ID tokens (payload `typ: "ID"`). A provider that puts `scope` in ID tokens would defeat that check: if it marks access tokens per RFC 9068 (`typ: at+jwt`), set `MCP_OAUTH_REQUIRE_AT_JWT=true` to check that header instead.
