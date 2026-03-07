# argocd-mcp-lite

Token-efficient MCP server for Argo CD, designed for AI agents. Drop-in replacement for `mcp-for-argocd` with ~85% fewer tokens.

## Commands

```bash
npm run build        # Build with tsup
npm test             # Run tests (vitest)
npm run lint         # Lint with eslint
npm run lint:fix     # Lint and auto-fix
npm run dev          # Dev mode with hot reload (HTTP transport)
```

## Architecture

- `src/server/server.ts` — MCP tool definitions (14 tools)
- `src/argocd/client.ts` — ArgoCD API client with token optimization
- `src/shared/models/schema.ts` — Zod schemas (ResourceRefSchema, ApplicationSchema)
- `src/cmd/cmd.ts` — CLI entrypoint (stdio/http/sse transports)

## Skill Maintenance

The ArgoCD skill at `.claude/skills/argocd/SKILL.md` teaches Claude how to use this MCP server effectively. **When making changes to the server, review and update the skill to stay in sync.** Specifically:

- **Tool changes** (`src/server/server.ts`): Update the tool quick reference table and workflow steps in the skill if tools are added, removed, renamed, or have parameter changes.
- **Schema changes** (`src/shared/models/schema.ts`): Update the ResourceRef shape and Application object shape sections in the skill.
- **Default changes**: If compact mode defaults, pagination defaults, or log tail defaults change, update the token efficiency rules section.
