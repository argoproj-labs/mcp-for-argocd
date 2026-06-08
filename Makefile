PNPM ?= pnpm

# Show this help by default: list every target that has a `## ` doc comment.
.DEFAULT_GOAL := help
.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# Local run configuration. Override on the command line, e.g.
#   make run PORT=4000
# By default the server starts with no credentials configured; supply tokens via
# environment variables (ARGOCD_API_TOKEN / ARGOCD_BASE_URL) or a registry
# (ARGOCD_TOKEN_REGISTRY_PATH). See "Running locally" in the README.
PORT ?= 3000

# Sentinel target: re-run install only when the lockfile or manifest changes.
node_modules: pnpm-lock.yaml package.json
	$(PNPM) install
	@touch node_modules

.PHONY: install
install: node_modules ## Install dependencies

.PHONY: lint
lint: node_modules ## Run the linter
	$(PNPM) run lint

.PHONY: test
test: node_modules ## Run the test suite
	$(PNPM) test

.PHONY: build
build: node_modules ## Build the npm package
	$(PNPM) run build

# Both targets run the server with whatever credentials are already in the
# environment. To configure them, export the relevant env var on the command
# line, e.g. `make run ARGOCD_BASE_URL=... ARGOCD_API_TOKEN=...` or
# `make run ARGOCD_TOKEN_REGISTRY_PATH=/path/to/tokens.json`.
.PHONY: run
run: build ## Build and run the server over HTTP
	node dist/index.js http --port $(PORT)

.PHONY: dev
dev: node_modules ## Run the server from source with live reload (HTTP)
	$(PNPM) run dev -- --port $(PORT)
