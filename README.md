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

## Docker Deployment

The Argo CD MCP server can be deployed as a Docker container, which is ideal for centralized deployments or when you don't want to manage a local Node.js environment.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running.
- Argo CD API access and token.

### Building the Image

To build the image locally from the root of the repository:

```bash
docker build -t argocd-mcp .
```

### Configuration

The container is configured using environment variables:

| Variable | Description | Required | Default |
| :--- | :--- | :--- | :--- |
| `ARGOCD_BASE_URL` | The full URL of your Argo CD instance (e.g., `https://argo.example.com`) | Yes | - |
| `ARGOCD_API_TOKEN` | Your Argo CD API Token | Yes | - |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to `0` to allow self-signed certificates | No | `1` |
| `MCP_READ_ONLY` | Set to `true` to disable write operations | No | `false` |

### Running the Container

The server supports two network-based transport modes when running in Docker: **HTTP Stream** (default) and **SSE**.

#### Option 1: HTTP Stream Transport (Default)
This mode is used by many MCP clients that expect a direct HTTP stream.

```bash
docker run -d \
  -p 3000:3000 \
  -e ARGOCD_BASE_URL="https://your-argocd.com" \
  -e ARGOCD_API_TOKEN="your-token-here" \
  --name argocd-mcp \
  argocd-mcp
```
*   **Access URL:** `http://localhost:3000/mcp`

#### Option 2: SSE (Server-Sent Events) Transport
Use this mode if your client requires an SSE-based connection. You must override the default command.

```bash
docker run -d \
  -p 3000:3000 \
  -e ARGOCD_BASE_URL="https://your-argocd.com" \
  -e ARGOCD_API_TOKEN="your-token-here" \
  --name argocd-mcp \
  argocd-mcp node dist/index.js sse
```
*   **Access URL:** `http://localhost:3000/sse`

### Troubleshooting

- **"Cannot GET /"**: The server does not serve anything on the root path. Ensure you are connecting to the correct endpoint (`/mcp` or `/sse`).
- **Connection Refused**: Verify that you have mapped the port correctly (`-p 3000:3000`).
- **400 Bad Request**: This usually happens when the required headers (`x-argocd-base-url` and `x-argocd-api-token`) are missing and they are not set as environment variables in the container.

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
