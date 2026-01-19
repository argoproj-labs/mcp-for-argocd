#!/bin/bash

# Multi-Instance ArgoCD MCP Server Run Script
# This script demonstrates running the MCP server with multiple ArgoCD instances

# Set READ_ONLY mode (set to "true" to disable write operations)
export MCP_READ_ONLY="true"

# Configure multiple ArgoCD instances using JSON
# Each instance needs: id, baseUrl, apiToken, and optionally description
export ARGOCD_CONFIG_JSON=$(cat <<'EOF'
{
  "instances": [
    {
      "id": "qa",
      "baseUrl": "https://argocd-sintral-testnet.toolsfdg.net",
      "apiToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcmdvY2QiLCJzdWIiOiJhcmdvY2Rfc3luYzphcGlLZXkiLCJuYmYiOjE3NjgyMDQ2NjMsImlhdCI6MTc2ODIwNDY2MywianRpIjoiNDc3MGUwY2YtZDM1My00MTcyLTk1ZDItZTIzMzFmNGRhM2U4In0.SBCV63iI9SAqGal-KGeBWjoA3M8shbKafJXh4BXRwUM",
      "description": "Sintral Testnet ArgoCD"
    },
    {
      "id": "qa-ap",
      "baseUrl": "https://argocd-sintral-qa.toolsfdg.net",
      "apiToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhcmdvY2QiLCJzdWIiOiJhcmdvY2Rfc3luYzphcGlLZXkiLCJuYmYiOjE3Njg4MTg2NDMsImlhdCI6MTc2ODgxODY0MywianRpIjoiYmE2MDU1MGQtNGVjYS00YjI2LWE3NTYtZTY5NzYzZGI3MWFjIn0.NqzznRZ1ceqPNi3FVS_9IaEjdQWc3gLJZnkt3Clk0pc",
      "description": "Sintral QA ArgoCD"
    }
  ],
  "defaultInstanceId": "qa"
}
EOF
)

# Optional: Disable SSL verification for self-signed certificates
# Uncomment the line below if needed (NOT recommended for production)
# export NODE_TLS_REJECT_UNAUTHORIZED="0"

echo "Starting ArgoCD MCP Server with multiple instances..."
echo "READ_ONLY mode: $MCP_READ_ONLY"
echo ""
echo "Configured instances:"
echo "  - qa (default)"
echo "  - qa-ap"
echo ""
echo "Starting HTTP server on port 3000..."
echo ""

# Build and run the MCP server in HTTP mode
pnpm run build && node dist/index.js http 3000
