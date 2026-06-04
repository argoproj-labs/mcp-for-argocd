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

### Cluster Management
- `list_clusters`: List all clusters registered with ArgoCD

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

The token is **mandatory**. On the HTTP transport, a connection that supplies no token (neither header nor env var) is rejected with `400 Bad Request`. Keeping the token out of tool arguments ensures it never enters prompts, model context, or tool-call logs.

#### Base URL — header / env var, or per-call argument

The base URL may be supplied at the session level (resolved once when the server starts or when an HTTP client connects):

- **HTTP headers** (HTTP transport only): `x-argocd-base-url`.
- **Environment variables**: `ARGOCD_BASE_URL` (all transports).

In addition, **every tool accepts an optional `argocdBaseUrl` argument**:

- If a session default base URL exists, `argocdBaseUrl` is **optional** and overrides the default for that single call.
- If no session default base URL is configured (header and env var both absent), `argocdBaseUrl` is **required**; a call without it returns an error.

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

> **Limitation — the per-call base URL reuses the session token.** Base URL and token are a coupled pair: each ArgoCD instance issues its own API token, but only the base URL can be overridden per call. The session token (from `x-argocd-api-token` / `ARGOCD_API_TOKEN`, captured when the session is initialized) is reused against whatever base URL is supplied. Overriding `argocdBaseUrl` to point at a **different** instance therefore only works if that instance accepts the same token; otherwise the call fails with `401`. To target instances that require **distinct** tokens, see the multi-instance pattern below.

#### Targeting multiple instances with distinct tokens (stateless + payload-aware proxy)

The recommended way to route to multiple ArgoCD instances — each with its own token — without ever putting the token in a tool-call payload is to run the server in [**stateless mode**](#stateless-mode) behind a proxy that injects the credential headers per request.

The catch is *which instance to inject a token for*. In practice the **agent harness chooses the target instance, and the only channel it controls is the JSON-RPC body** — an MCP client/agent can set the `argocdBaseUrl` tool argument, but it cannot set arbitrary HTTP headers like `x-argocd-base-url`. So the proxy cannot rely on a header the agent set; instead it must **parse the request body, extract `params.arguments.argocdBaseUrl`, look up the matching token, and inject the correctly-paired `x-argocd-base-url` and `x-argocd-api-token` headers** before forwarding the request.

In stateless mode the server resolves `x-argocd-base-url` / `x-argocd-api-token` **fresh on every request** (in the default stateful mode the headers are read only once, at session initialization, and reused for the whole session — so dynamic per-request injection has no effect there).

```
                          reads body, extracts params.arguments.argocdBaseUrl
                          looks up matching token, injects PAIRED headers
                                            │
client / agent ──▶ proxy ──────────────────┴───────────────▶ MCP (stateless)
   sets argocdBaseUrl       ┌── x-argocd-base-url:  <from payload> ──┐
   in tool args (body)      └── x-argocd-api-token: <token for that base url> ──┘
```

Notes / caveats of this approach:

- The proxy must parse JSON-RPC bodies and maintain a `baseUrl → token` map. This couples the proxy to the MCP message schema and to the tool-argument name (`argocdBaseUrl`).
- The proxy must inject **both** headers together so the base URL and token stay a matched pair.
- The token never enters the model context, prompt, or tool-call logs — it lives only in the request header injected by the proxy. The base URL, however, is still in the payload (it is not a secret).
- Streaming/batched requests and non-`tools/call` methods (e.g. `tools/list`) won't carry an `argocdBaseUrl`; the proxy needs a sensible default for those.

##### Better alternatives to a payload-parsing proxy

Parsing the body in the proxy works but is brittle. If you control the server, these are cleaner ways to solve the coupled base-URL/token problem:

1. **Server-side credential map (recommended).** Configure the server with a `baseUrl → token` (or `name → {baseUrl, token}`) map via env/secret. The caller passes only a non-secret selector — `argocdBaseUrl` or a logical `argocdInstance` name — and the server looks up the paired token itself. No proxy, no body parsing, token never in the payload, and base URL/token can never drift out of sync. This is the most robust fit for the "agent picks the instance per call" use case.
2. **One connection per instance.** Bind each session to a single instance by sending that instance's `x-argocd-base-url` + `x-argocd-api-token` at connection time, and open a separate connection per instance. Works today with zero proxy logic; the trade-off is the agent manages multiple MCP endpoints instead of one.
3. **Proxy keyed on transport metadata, not the body.** If a payload-aware proxy is undesirable, have the proxy route on something it can see without parsing the body — the request path (`/mcp/prod`, `/mcp/staging`), an auth claim, or a dedicated routing header the *deployment* (not the agent) sets — and inject the paired headers from that. This keeps the agent out of base-URL selection entirely.

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
docker run -e ARGOCD_BASE_URL=<argocd_url> -e ARGOCD_API_TOKEN=<argocd_token> \
  argoprojlabs/mcp-for-argocd http --stateless
```

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