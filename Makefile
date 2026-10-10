CLUSTER := urumi
K3D_CONFIG := scripts/k3d-config.yaml

.PHONY: help install typecheck lint test check cluster-up cluster-down

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	pnpm install --frozen-lockfile

typecheck: ## Typecheck all apps
	pnpm typecheck

lint: ## Lint and format check
	pnpm lint
	pnpm format:check

test: ## Run unit tests
	pnpm test

check: typecheck lint test ## Typecheck, lint and test

cluster-up: ## Create the local k3d cluster (idempotent)
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config $(K3D_CONFIG)
	kubectl config use-context k3d-$(CLUSTER)
	kubectl wait --for=condition=Ready nodes --all --timeout=120s

cluster-down: ## Delete the local k3d cluster and all its data
	k3d cluster delete $(CLUSTER)
