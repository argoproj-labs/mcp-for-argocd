---
name: argocd
description: Manages Argo CD applications, deployments, and Kubernetes resources via the argocd-mcp-lite MCP server. Use when the user asks about Argo CD applications, syncing, deployment status, Kubernetes resource health, pod logs, application events, or any ArgoCD-managed workload troubleshooting.
---

# ArgoCD MCP Server Skill

You have access to the `argocd-mcp-lite` MCP server — a token-efficient interface to Argo CD. Follow these rules and workflows to use it effectively.

## Token Efficiency Rules

- Always use `compact=true` (the default). Only set `compact=false` when the user explicitly asks for full unfiltered output.
- Use filters on `get_application_resource_tree` (`kind`, `health`, `namespace`) and `get_application_managed_resources` (`kind`, `namespace`, `name`, `version`, `group`) to reduce response size.
- Use `limit` and `offset` on `list_applications` for pagination. Default to `limit=10` when browsing.
- Use `sinceMinutes` on event queries and `sinceSeconds` on log queries to scope results to relevant time windows.
- Keep `tailLines=50` (default) for logs; only increase when the user needs more.

## Critical: get_resources Requires Resource Tree First

`get_resources` **requires** a non-empty `resourceRefs` array — it will error if empty. You must always:

1. Call `get_application_resource_tree` (with filters) to discover resources
2. Extract `resourceRef` objects from the response nodes
3. Pass those refs to `get_resources`

### ResourceRef Shape

All fields are required strings:

```json
{ "uid": "", "kind": "", "namespace": "", "name": "", "version": "", "group": "" }
```

## Common Workflows

### Debug a Failing Application

1. `get_application` — check sync status and health
2. `get_application_resource_tree` with `health="Degraded"` — find unhealthy resources
3. `get_resource_events` for degraded resources — read event messages for errors
4. `get_application_workload_logs` for relevant pods — check container logs
5. Summarize root cause and recommend a fix

### Check Application Health

1. `get_application` — quick health and sync overview
2. If degraded: `get_application_resource_tree` with `health="Degraded"` to identify which resources are unhealthy

### Sync / Deploy

1. `get_application` — check current state before syncing
2. `sync_application` with `dryRun=true` first if the user wants to preview changes
3. `sync_application` to apply (set `prune=true` to remove stale resources)
4. `get_application` — verify sync completed successfully
5. If issues: follow the debug workflow above

### View Specific Resources

1. `get_application_resource_tree` with `kind` filter (e.g., `kind="Deployment"`)
2. Extract `resourceRef` objects from the matching nodes
3. `get_resources` with those refs to get full manifests

### Check Recent Events

1. `get_application_events` with `sinceMinutes` for app-level events
2. For resource-specific events: get the resource's UID from the resource tree, then call `get_resource_events`

### Restart or Run Resource Actions

1. `get_application_resource_tree` with `kind` filter to locate the resource
2. `get_resource_actions` to discover available actions (e.g., restart)
3. `run_resource_action` to execute the chosen action

## Tool Quick Reference

### Read Tools (always available)

| Tool | Key Parameters |
|------|---------------|
| `list_applications` | `search`, `limit`, `offset` |
| `get_application` | `applicationName`, `compact` (default: true) |
| `get_application_resource_tree` | `applicationName`, `kind`, `health`, `namespace`, `compact` |
| `get_application_managed_resources` | `applicationName`, `kind`, `namespace`, `name`, `version`, `group` |
| `get_resources` | `applicationName`, `applicationNamespace`, `resourceRefs` (**required**) |
| `get_application_workload_logs` | `applicationName`, `applicationNamespace`, `resourceRef`, `container`, `tailLines`, `sinceSeconds` |
| `get_application_events` | `applicationName`, `limit`, `sinceMinutes` |
| `get_resource_events` | `applicationName`, `applicationNamespace`, `resourceUID`, `resourceNamespace`, `resourceName`, `limit`, `sinceMinutes` |
| `get_resource_actions` | `applicationName`, `applicationNamespace`, `resourceRef` |

### Write Tools (unavailable in read-only mode)

| Tool | Key Parameters |
|------|---------------|
| `create_application` | `application` object |
| `update_application` | `applicationName`, `application` object |
| `delete_application` | `applicationName`, `applicationNamespace`, `cascade`, `propagationPolicy` |
| `sync_application` | `applicationName`, `applicationNamespace`, `dryRun`, `prune`, `revision`, `syncOptions` |
| `run_resource_action` | `applicationName`, `applicationNamespace`, `resourceRef`, `action` |

## Application Object Shape (for create/update)

```json
{
  "metadata": { "name": "my-app", "namespace": "argocd" },
  "spec": {
    "project": "default",
    "source": { "repoURL": "https://github.com/...", "path": "k8s/", "targetRevision": "HEAD" },
    "destination": { "server": "https://kubernetes.default.svc", "namespace": "my-namespace" },
    "syncPolicy": {
      "syncOptions": ["CreateNamespace=true"],
      "automated": { "prune": true, "selfHeal": true },
      "retry": { "limit": 3, "backoff": { "duration": "5s", "maxDuration": "3m", "factor": 2 } }
    }
  }
}
```

- `destination` must have exactly one of `server` or `name`, not both.
- `automated` is optional. Omit it for manual sync only.

## Important Notes

- `applicationNamespace` refers to the namespace of the **ArgoCD Application resource itself** (typically `"argocd"`), not the destination namespace where workloads are deployed.
- If a write tool is not found, the server is likely running in read-only mode (`MCP_READ_ONLY=true`). Inform the user.
- Tool names may be prefixed with the MCP server name from the user's config (e.g., `argocd:list_applications`).
