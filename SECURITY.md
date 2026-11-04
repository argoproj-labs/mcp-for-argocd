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

- **The token gates the listener, not the caller.** `MCP_AUTH_TOKEN` is one shared secret, not a per-caller identity. Anyone holding it can call every registered tool and, with a [token registry](README.md#token-registry--per-base-url-tokens-multi-instance), target any base URL in it. For different reach per caller, run separate instances, each with its own token, registry entries, and [read-only mode](README.md#read-only-mode).
- **A proxy or a published port changes the `Origin`.** The allowed loopback origins use the port the server itself binds. Through `-p 8080:3000` or a TLS proxy the browser sends the origin it sees, so pass that to `--allowed-origin`. The `403` echoes the value it rejected.
- **Non-`http(s)` origins work, `null` does not.** `vscode-webview://<id>` and `chrome-extension://<id>` match as exact strings. The `null` a sandboxed or `file://` context sends is refused, since allowing it would admit every such context at once.
- **`Origin` alone is not enough on an exposed bind.** A browser omits `Origin` on a same-origin `GET`, and a DNS-rebound page believes it is same-origin. `Host` validation is what covers that, so pass `--allowed-host-header` or set `MCP_AUTH_TOKEN`. A proxy that forwards the client's original `Host` needs that name allow-listed too.
- **Browsers cannot call this server directly.** It sends no CORS headers, and `MCP_AUTH_TOKEN` cannot be attached to an `EventSource`. `--allowed-origin` only keeps *this* layer from rejecting a browser client that sits behind a CORS-terminating proxy.
- **Token whitespace.** Surrounding whitespace is stripped, since `$(cat token)` and `--from-file` secrets carry a trailing newline. Whitespace inside the token is a startup error, because such a token could never be sent in a header.
- **Bind address.** All of `127.0.0.0/8` counts as loopback, and IPv6 works with or without brackets. The default is IPv4 only, so a client insisting on `http://[::1]:3000` needs `--bind-address ::1`, or `::` for both stacks.
- **Loopback is reachable from a same-pod sidecar.** A published port (`docker run -p …`) is what does not reach a loopback listener; that needs an explicit wider bind.
