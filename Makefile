PNPM ?= pnpm

.PHONY: install
install: ## Install dependencies
	$(PNPM) install

.PHONY: lint
lint: ## Run the linter
	$(PNPM) run lint

.PHONY: test
test: ## Run the test suite
	$(PNPM) test

.PHONY: build
build: ## Build the npm package
	$(PNPM) run build