CLUSTER := urumi
K3D_CONFIG := scripts/k3d-config.yaml
HELM_TIMEOUT := 15m

.PHONY: help install typecheck lint test check cluster-up cluster-down deploy-store deploy-local helm-lint e2e

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

helm-lint: ## Lint every chart with its local values
	@for c in charts/*/; do helm lint $$c -f $$c/values-local.yaml || exit 1; done

deploy-store: ## Install or upgrade the store release (namespace store)
	helm upgrade --install store charts/store -n store --create-namespace \
		-f charts/store/values-local.yaml --wait --timeout $(HELM_TIMEOUT)

deploy-local: deploy-store ## Deploy everything to the local cluster

e2e: ## Run end-to-end checks against the local cluster
	scripts/e2e.sh
