# Argo CD MCP Server

An implementation of [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Argo CD](https://argo-cd.readthedocs.io/en/stable/), enabling AI assistants to interact with your Argo CD applications through natural language. This server allows for seamless integration with Visual Studio Code and other MCP clients through stdio and HTTP stream transport protocols.

<a href="https://glama.ai/mcp/servers/@akuity/argocd-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@akuity/argocd-mcp/badge" alt="argocd-mcp MCP server" />
</a>

<!--
// Generate using?:
const config = JSON.stringify({
  "name": "argocd-mcp",
  "command": "npx",
  "args": ["argocd-mcp@latest", "stdio"],
  "env": {
    "ARGOCD_BASE_URL": "<argocd_url>",
    "ARGOCD_API_TOKEN": "<argocd_token>"
  }
});
const urlForWebsites = `vscode:mcp/install?${encodeURIComponent(config)}`;
// Github markdown does not allow linking to `vscode:` directly, so you can use our redirect:
const urlForGithub = `https://insiders.vscode.dev/redirect?url=${encodeURIComponent(urlForWebsites)}`;
-->

[<img src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20Server&color=0098FF" alt="Install in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522argocd-mcp%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522argocd-mcp%2540latest%2522%252C%2522stdio%2522%255D%252C%2522env%2522%253A%257B%2522ARGOCD_BASE_URL%2522%253A%2522%253Cargocd_url%253E%2522%252C%2522ARGOCD_API_TOKEN%2522%253A%2522%253Cargocd_token%253E%2522%257D%257D)  [<img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20Server&color=24bfa5">](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522argocd-mcp%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522argocd-mcp%2540latest%2522%252C%2522stdio%2522%255D%252C%2522env%2522%253A%257B%2522ARGOCD_BASE_URL%2522%253A%2522%253Cargocd_url%253E%2522%252C%2522ARGOCD_API_TOKEN%2522%253A%2522%253Cargocd_token%253E%2522%257D%257D)

---
![argocd-mcp-demo](https://github.com/user-attachments/assets/091548d0-9927-4d4b-a2fe-4f99c7cea108)

## Features

- **Transport Protocols**: Supports both stdio and HTTP stream transport modes for flexible integration with different clients
- **Complete Argo CD API Integration**: Provides comprehensive access to Argo CD resources and operations
- **AI Assistant Ready**: Pre-configured tools for AI assistants to interact with Argo CD in natural language

## Available Tools

The server provides the following ArgoCD management tools:

### Profile Management
- `list_profiles`: List the configured ArgoCD profiles (named instances) and the active/default one
- `get_current_profile`: Get the profile active for the current session
- `set_profile`: Select the active profile by name (see [Profiles](#profiles--multiple-instances-from-your-argo-cd-cli-config))

### Cluster Management
- `list_clusters`: List all clusters registered with ArgoCD

### Project Management
- `get_appproject`: Get detailed information about a specific AppProject (project)

### Application Management
- `list_applications`: List and filter all applications
- `get_application`: Get detailed information about a specific application
- `create_application`: Create a new application
- `update_application`: Update an existing application
- `delete_application`: Delete an application
- `sync_application`: Trigger a sync operation on an application

### Resource Management
- `get_application_resource_tree`: Get the resource tree for a specific application
- `get_application_managed_resources`: Get managed resources for a specific application
- `get_application_workload_logs`: Get logs for application workloads (Pods, Deployments, etc.)
- `get_resource_events`: Get events for resources managed by an application
- `get_resource_actions`: Get available actions for resources
- `run_resource_action`: Run an action on a resource

## Installation

### Prerequisites

- Node.js (v18 or higher recommended)
- pnpm package manager (for development)
- Argo CD instance with API access
- Argo CD API token (see the [docs for instructions](https://argo-cd.readthedocs.io/en/stable/developer-guide/api-docs/#authorization)) 

### Usage with Cursor
1. Follow the [Cursor documentation for MCP support](https://docs.cursor.com/context/model-context-protocol), and create a `.cursor/mcp.json` file in your project:
```json
{
  "mcpServers": {
    "argocd-mcp": {
      "command": "npx",
      "args": [
        "argocd-mcp@latest",
        "stdio"
      ],
      "env": {
        "ARGOCD_BASE_URL": "<argocd_url>",
        "ARGOCD_API_TOKEN": "<argocd_token>"
      }
    }
  }
}
```

2. Start a conversation with Agent mode to use the MCP.

### Usage with VSCode

1. Follow the [Use MCP servers in VS Code documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers), and create a `.vscode/mcp.json` file in your project:
```json
{
  "servers": {
    "argocd-mcp-stdio": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "argocd-mcp@latest",
        "stdio"
      ],
      "env": {
        "ARGOCD_BASE_URL": "<argocd_url>",
        "ARGOCD_API_TOKEN": "<argocd_token>"
      }
    }
  }
}
```

2. Start a conversation with an AI assistant in VS Code that supports MCP.

### Usage with Claude Desktop

1. Follow the [MCP in Claude Desktop documentation](https://modelcontextprotocol.io/quickstart/user), and create a `claude_desktop_config.json` configuration file:
```json
{
  "mcpServers": {
    "argocd-mcp": {
      "command": "npx",
      "args": [
        "argocd-mcp@latest",
        "stdio"
      ],
      "env": {
        "ARGOCD_BASE_URL": "<argocd_url>",
        "ARGOCD_API_TOKEN": "<argocd_token>"
      }
    }
  }
}
```

2. Configure Claude Desktop to use this configuration file in settings.

### Self-signed Certificates

If your Argo CD instance uses self-signed certificates or certificates from a private Certificate Authority (CA), you may need to add the following environment variable to your configuration:

```
"NODE_TLS_REJECT_UNAUTHORIZED": "0"
```

This disables TLS certificate validation for Node.js when connecting to Argo CD instances using self-signed certificates or certificates from private CAs that aren't trusted by your system's certificate store.

> **Warning**: Disabling SSL verification reduces security. Use this setting only in development environments or when you understand the security implications.


### Providing ArgoCD Credentials

The server connects to ArgoCD using a **base URL** and an **API token**.

#### API token — header / env var only (mandatory)

The ArgoCD **API token is a secret and is only ever read from the transport layer**, never from a tool-call argument:

- **HTTP headers** (HTTP transport only): `x-argocd-api-token`.
- **Environment variables**: `ARGOCD_API_TOKEN` (all transports).

This token is **outbound only**: it authenticates this server to ArgoCD and never authorizes an inbound caller. See [Network Exposure](#network-exposure) for who may reach the listener.

This is the **default token**. It is **mandatory unless [profiles](#profiles--multiple-instances-from-your-argo-cd-cli-config) are configured**: on the HTTP transport, a connection that supplies no token (neither header nor env var) is rejected with `400 Bad Request`, but when profiles are configured a tokenless connection is allowed because each call resolves its own [profile token](#two-kinds-of-token). Keeping the token out of tool arguments ensures it never enters prompts, model context, or tool-call logs.

#### Base URL — header / env var, or per-call argument

The base URL may be supplied at the session level (resolved once when the server starts or when an HTTP client connects):

- **HTTP headers** (HTTP transport only): `x-argocd-base-url`.
- **Environment variables**: `ARGOCD_BASE_URL` (all transports).

In addition, **every tool accepts an optional `argocdBaseUrl` argument**:

- If a session default base URL exists, `argocdBaseUrl` is **optional** and overrides the default for that single call.
- If no session default base URL is configured (header and env var both absent), `argocdBaseUrl` is **required**; a call without it returns an error.

#### Profiles — multiple instances from your Argo CD CLI config

To target **multiple ArgoCD instances**, point the server at your existing **Argo CD CLI config file** — the one written by `argocd login` / `argocd context` (default location `~/.config/argocd/config`). Every context in it becomes a selectable **profile**, reusing the credentials you already have, including tokens obtained via **SSO/OIDC or LDAP** through `argocd login --sso`. No separate token file to maintain.

Reading the config is **opt-in**: provide the path explicitly via the `--config` flag or the `ARGOCD_CONFIG` environment variable. The default `~/.config/argocd/config` location is **never read implicitly**.

```bash
# CLI flag
argocd-mcp stdio --config ~/.config/argocd/config
# or environment variable
ARGOCD_CONFIG=~/.config/argocd/config argocd-mcp stdio
```

Each context maps to a profile: its `server` becomes the base URL (`https://`, or `http://` when the matching `servers` entry is marked `plain-text`), and the linked user's `auth-token` becomes the token. The file's `current-context` becomes the **default/active** profile. Contexts with no `auth-token` (never logged in, or an expired session) are skipped with a warning.

Three tools manage the active profile **per session** — profile names are **non-secret**, but tokens are **never** exposed by any of them:

- `list_profiles` — lists the configured profiles as `{ name, baseUrl }` (never tokens), plus which profile is currently `active` and which is the `default`.
- `get_current_profile` — returns the profile active for this session (or the default base URL when none is active).
- `set_profile` — selects the active profile by `name` (case-insensitive). Subsequent tool calls that don't pass an `argocdBaseUrl` override target that profile's instance.

> **Secure the file.** The config holds bearer tokens, so restrict it to the server's user (the `argocd` CLI writes it `0600` by default) and prefer a secret-management mechanism (Kubernetes secret volume, Vault agent, etc.) over a plaintext file when deploying.

> **Stateless HTTP mode.** In [stateless mode](#stateless-mode) a fresh server is built per request, so `set_profile` does not persist across requests — it returns a warning to that effect. Rely on the `current-context` default profile instead.

The per-call `argocdBaseUrl` argument still takes precedence over the active profile for a single call, and is still subject to the token boundary below.

##### Two kinds of token

The server resolves calls using one of two distinct tokens. Keeping them straight is what makes the security model work:

| | **Default token** | **Profile token** |
|---|---|---|
| **Source** | `x-argocd-api-token` header / `ARGOCD_API_TOKEN` env var (the session credential) | A context's `auth-token` in the Argo CD CLI config, keyed by its base URL |
| **Scope** | The **default base URL only** (`x-argocd-base-url` / `ARGOCD_BASE_URL`) | The **specific base URL** of that profile |
| **Used for** | A call that targets the default base URL | A call that targets any profile's base URL (including the default, as a fallback) |
| **Never used for** | Any base URL other than the default — it is **never** sent to a different host | Any base URL not present in the config |

The cardinal rule: **the default token is bound to the default base URL; every other host's token must come from a configured profile.** A profile token is bound to exactly the host it is configured for.

##### Resolution order

For a given call, the resolved base URL is the `argocdBaseUrl` argument if supplied, otherwise the active profile's base URL, otherwise the session default. The token is then chosen by:

1. **Call targets the default base URL** → use the **default token**. If no default token was supplied (a tokenless session), fall back to the **profile token** for that base URL, if one exists.
2. **Call targets any other base URL** → use the **profile token** for that base URL only. The **default token is never used here** — it is not sent to a host other than the default one.
3. If neither applies (no token can be resolved for the requested base URL), the call returns a "Missing required ArgoCD API token" error and **no request is made** to that host.

> **Why the default token is bound to the default base URL.** The `argocdBaseUrl` argument comes from the tool call, so a caller (or a prompt-injected model) could point it at an arbitrary host. If the default token were paired with any supplied base URL, that token would be sent — as an `Authorization: Bearer` header — to the attacker's host. Restricting the default token to the default base URL, and requiring a configured profile for every other host, prevents this token exfiltration.

Base URLs are normalized for lookup (lowercased host, trailing slashes ignored), so minor formatting differences still match. When profiles are configured, the HTTP transport no longer requires `x-argocd-api-token` at connection time — a tokenless connection is allowed because the per-call base URL resolves its own token. If `--config` / `ARGOCD_CONFIG` is set but the file is missing, unreadable, or malformed, the server **fails closed**: it throws at startup rather than silently running with no profiles.

For example, a `tools/call` request overriding only the base URL:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_applications",
    "arguments": {
      "argocdBaseUrl": "https://argocd.other-cluster.example.com"
    }
  }
}
```

> **Overriding the base URL to a different instance requires a configured profile.** The default token (`x-argocd-api-token` / `ARGOCD_API_TOKEN`) is bound to the default base URL only and is never sent to a different host. Overriding `argocdBaseUrl` to point at the **default** instance (same host, formatting aside) reuses the default token; pointing it at any **other** instance requires a profile for that instance in your Argo CD CLI config, otherwise the call fails with "Missing required ArgoCD API token" and no request is sent. This is intentional — see [why the default token is bound to the default base URL](#profiles--multiple-instances-from-your-argo-cd-cli-config) above. Selecting a profile by name with `set_profile` is the convenient alternative to passing raw base URLs.

### Network Exposure

The `http` and `sse` transports open a network listener that reaches every ArgoCD tool, including `create_application`, `delete_application`, `sync_application`, and `run_resource_action`. By default it binds loopback only.

**`ARGOCD_API_TOKEN` does not protect it.** That token authenticates this server *to ArgoCD*. It says nothing about who the caller is. Inbound access is controlled by the settings below.

| Setting | Flag | Env var | Default | What it does |
|---|---|---|---|---|
| Bind address | `--bind-address` | `MCP_BIND_ADDRESS` | `127.0.0.1` | Which address the listener accepts connections on. |
| Inbound token | — | `MCP_AUTH_TOKEN` | unset | When set, every request must carry `Authorization: Bearer <token>`. |
| Allowed `Host` | `--allowed-host-header` | — | loopback names | Extra hostname accepted in a request's `Host` header. Repeat per name. |
| Allowed `Origin` | `--allowed-origin` | — | loopback origins | Extra browser origin accepted in a request's `Origin` header. Repeat per origin. |
| External auth | `--allow-unauthenticated` | — | `false` | Allows a non-loopback bind with no token, when something in front already authenticates callers. |
| Port | `--port` | — | `3000` | Which port to listen on. |

> `--bind-address` decides who may connect. `--allowed-host-header` only checks what an already-connected client claims. They are not a pair, and the second is not a firewall.

Flags with no env var are passed as arguments, in a container too: `docker run <image> http --allow-unauthenticated`.

Behaviour:

- Widening the bind requires `MCP_AUTH_TOKEN` or `--allow-unauthenticated`. Otherwise the server logs why and exits non-zero instead of starting exposed.
- `Origin` is always checked, on scheme, host, and port. This is what stops a malicious web page, including one using DNS rebinding.
- `Host` is checked on a loopback bind, or on any bind with at least one `--allowed-host-header`. Otherwise the hostname clients legitimately use is unknown, so the check is skipped and a warning is logged.
- `GET /healthz` is exempt, so a kubelet probe still succeeds. It returns liveness only.
- Unusable configuration fails at startup with the reason, rather than being ignored.
- [Read-only mode](#read-only-mode) is independent of all of this and caps what any caller can do.

Exposing the listener deliberately:

```bash
export MCP_AUTH_TOKEN=<inbound_token>
node dist/index.js http --bind-address 0.0.0.0 --allowed-host-header mcp.internal.example.com
```

The container image keeps the same loopback default, so it needs no extra configuration when the caller shares its network namespace, such as a sidecar in the same Kubernetes pod:

```bash
docker run -e ARGOCD_BASE_URL=<argocd_url> -e ARGOCD_API_TOKEN=<argocd_token> \
  argoprojlabs/mcp-for-argocd
```

To publish a port, widen the bind and set an inbound credential:

```bash
docker run -p 3000:3000 \
  -e ARGOCD_BASE_URL=<argocd_url> -e ARGOCD_API_TOKEN=<argocd_token> \
  -e MCP_BIND_ADDRESS=0.0.0.0 -e MCP_AUTH_TOKEN=<inbound_token> \
  argoprojlabs/mcp-for-argocd
```

When the bind is widened and a proxy or mesh already authenticates callers, use `--allow-unauthenticated` instead of `MCP_AUTH_TOKEN`.

See [Operator notes](SECURITY.md#operator-notes-network-exposure) for the deployment caveats.

### Read Only Mode

If you want to run the MCP Server in a ReadOnly mode to avoid resource or application modification, you should set the environment variable:
```
"MCP_READ_ONLY": "true"
```
This will disable the following tools:
- `create_application`
- `update_application`
- `delete_application`
- `sync_application`
- `run_resource_action`

By default, all the tools will be available.

### Stateless Mode

By default, the HTTP transport assigns a session ID to each client connection and keeps an in-memory map of active sessions. This works well for single-instance deployments but causes `400` errors when multiple replicas are running without sticky sessions, because a request routed to a different pod will not find the session that was created on the original pod.

To run without session affinity requirements, start the server with the `--stateless` flag:

```bash
node dist/index.js http --stateless
```

Or with Docker:

```bash
docker run -p 3000:3000 \
  -e ARGOCD_BASE_URL=<argocd_url> -e ARGOCD_API_TOKEN=<argocd_token> \
  -e MCP_BIND_ADDRESS=0.0.0.0 -e MCP_AUTH_TOKEN=<inbound_token> \
  argoprojlabs/mcp-for-argocd http --stateless
```

The image has an `ENTRYPOINT`, so overriding the command replaces only the arguments. Publishing a port is what makes the wider bind and the inbound token necessary here; see [Network Exposure](#network-exposure).

In stateless mode:
- No `Mcp-Session-Id` is returned or required — any replica can handle any request
- ArgoCD credentials must be supplied on every request via environment variables or `x-argocd-base-url` / `x-argocd-api-token` headers (the base URL may also be overridden per call via the `argocdBaseUrl` tool argument; the API token is always header/env only)
- `GET /mcp` and `DELETE /mcp` return `405 Method Not Allowed` (session-level SSE and termination are not supported)

This mode is recommended for Kubernetes deployments with Horizontal Pod Autoscaling (HPA) where network-level sticky sessions are not available.

## For Development

1. Clone the repository:
```bash
git clone https://github.com/argoproj-labs/mcp-for-argocd.git
cd mcp-for-argocd
```

2. Install project dependencies:
```bash
pnpm install
```

3. Start the development server with hot reloading enabled:
```bash
pnpm run dev
```
Once the server is running, you can utilize the MCP server within Visual Studio Code or other MCP client.

### Running locally

The `Makefile` provides targets for running the server over the HTTP transport:

```bash
make run    # build, then run the HTTP server (production-style)
make dev    # run from source with hot reloading (tsx watch)
```

By default neither target sets any credentials — the server starts with no default base URL or token, so callers must supply them per request (`x-argocd-base-url` / `x-argocd-api-token` headers, or the `argocdBaseUrl` tool argument once profiles are configured). Override the port the same way:

```bash
make run PORT=4000
```

To configure credentials, export the relevant environment variable on the command line. There are three (all optional):

| Variable | Purpose |
|---|---|
| `ARGOCD_BASE_URL` | Default ArgoCD instance URL used when a call doesn't override it. |
| `ARGOCD_API_TOKEN` | Static API token for the default base URL. |
| `ARGOCD_CONFIG` | Path to an [Argo CD CLI config file](#profiles--multiple-instances-from-your-argo-cd-cli-config) whose contexts are loaded as profiles (for targeting multiple instances). Equivalent to the `--config` flag. |

These are all outbound credentials. For who may reach the listener, see [Network Exposure](#network-exposure).

```bash
# Single instance with a static base URL + token:
make run ARGOCD_BASE_URL=https://argo.example.com ARGOCD_API_TOKEN=<token>

# Multiple instances via your Argo CD CLI config (each context becomes a profile):
make run ARGOCD_CONFIG=~/.config/argocd/config

# Both — a default base URL/token plus profiles resolved from the config:
make dev ARGOCD_BASE_URL=https://argo.example.com ARGOCD_API_TOKEN=<token> \
  ARGOCD_CONFIG=~/.config/argocd/config
```

See [Profiles](#profiles--multiple-instances-from-your-argo-cd-cli-config) for how the default token and profile tokens interact. If `ARGOCD_CONFIG` is set but the file is missing, unreadable, or malformed, the server fails closed at startup.

> **Keep tokens out of your shell history.** Passing `ARGOCD_API_TOKEN=<token>` directly on the `make` command line records the secret in your shell history and exposes it in the process list. Prefer exporting it in the shell first so it never appears in the `make` invocation:
> ```bash
> export ARGOCD_API_TOKEN=<token>
> make run ARGOCD_BASE_URL=https://argo.example.com
> ```
> A config path (`ARGOCD_CONFIG`) and base URL are not secrets, so they're fine to pass inline.

> Do not place the registry file under `dist/` — `tsup` builds with `clean: true` and wipes that directory on every build.

The HTTP server listens on `POST /mcp` (`127.0.0.1:3000` by default, see [Network Exposure](#network-exposure) to widen it) with a `GET /healthz` liveness endpoint. To send a request, first `initialize` a session (capture the `mcp-session-id` response header), then call a tool, passing one of your configured base URLs as the `argocdBaseUrl` argument (or select a profile with `set_profile`):

```bash
# 1. Initialize a session — note the mcp-session-id response header
curl -sD - http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2. Call a tool, reusing that session id
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <session-id-from-step-1>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_applications","arguments":{"argocdBaseUrl":"https://argo-a.example.com"}}}'
```

To avoid managing a session id, run in [stateless mode](#stateless-mode) (`node dist/index.js http --stateless`) so every `POST /mcp` is self-contained.

### Upgrading ArgoCD Types

To update the TypeScript type definitions based on the latest Argo CD API specification:

1. Download the `swagger.json` file from the [ArgoCD release page](https://github.com/argoproj/argo-cd/releases), for example here is the [swagger.json link](https://github.com/argoproj/argo-cd/blob/v2.14.11/assets/swagger.json) for ArgoCD v2.14.11.

2. Place the downloaded `swagger.json` file in the root directory of the `argocd-mcp` project.

3. Generate the TypeScript types from the Swagger definition by running the following command. This will create or overwrite the `src/types/argocd.d.ts` file:
    ```bash
    pnpm run generate-types
    ```

4. Update the `src/types/argocd-types.ts` file to export the required types from the newly generated `src/types/argocd.d.ts`. This step often requires manual review to ensure only necessary types are exposed.

## Credits

The project was initially created and donated by [@jiachengxu](https://github.com/jiachengxu), [@imwithye](https://github.com/imwithye), [@hwwn](https://github.com/hwwn), and [@alexmt](https://github.com/alexmt) from [Akuity](https://akuity.io/).
