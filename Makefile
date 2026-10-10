CLUSTER := urumi
K3D_CONFIG := scripts/k3d-config.yaml
HELM_TIMEOUT := 15m
# Content hash of each image's inputs: unchanged code keeps its tag, changed code gets a new one,
# so `helm upgrade` only restarts what changed.
src_hash = $(shell cat $$(git ls-files -co --exclude-standard $(1) pnpm-lock.yaml tsconfig.base.json | sort) | shasum | cut -c1-12)
WOO_MCP_TAG := $(call src_hash,apps/woo-mcp)
GATEWAY_TAG := $(call src_hash,apps/gateway)
EVERYTHING_TAG := 2026.8.31

.PHONY: help install typecheck lint test check cluster-up cluster-down deploy-store deploy-upstreams deploy-platform deploy-local helm-lint e2e images

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
	@for c in charts/*/; do helm lint $$c -f $$c/values-local.yaml --set allowMissingUpstreamSecrets=true || exit 1; done

images: ## Build app images and import them into the k3d cluster
	docker build -f apps/woo-mcp/Dockerfile -t urumi/woo-mcp:$(WOO_MCP_TAG) .
	docker build -f apps/gateway/Dockerfile -t urumi/gateway:$(GATEWAY_TAG) .
	docker build -f images/everything/Dockerfile -t urumi/everything:$(EVERYTHING_TAG) images/everything
	k3d image import -c $(CLUSTER) urumi/woo-mcp:$(WOO_MCP_TAG) urumi/gateway:$(GATEWAY_TAG) urumi/everything:$(EVERYTHING_TAG)

deploy-store: ## Install or upgrade the store release (namespace store)
	helm upgrade --install store charts/store -n store --create-namespace \
		-f charts/store/values-local.yaml --set wooMcp.image.tag=$(WOO_MCP_TAG) \
		--wait --timeout $(HELM_TIMEOUT)

deploy-upstreams: ## Install or upgrade the in-cluster demo MCP servers (namespace demo-upstreams)
	helm upgrade --install demo-upstreams charts/demo-upstreams -n demo-upstreams --create-namespace \
		-f charts/demo-upstreams/values-local.yaml --wait --timeout $(HELM_TIMEOUT)

# Optional secrets (e.g. llm.apiKey) live in a gitignored file.
PLATFORM_SECRETS := $(wildcard charts/platform/values-secrets.local.yaml)

deploy-platform: ## Install or upgrade the platform release (namespace platform)
	helm upgrade --install platform charts/platform -n platform --create-namespace \
		-f charts/platform/values-local.yaml $(if $(PLATFORM_SECRETS),-f $(PLATFORM_SECRETS)) \
		--set gateway.image.tag=$(GATEWAY_TAG) --wait --timeout $(HELM_TIMEOUT)

deploy-local: images deploy-store deploy-upstreams deploy-platform ## Build images and deploy everything to the local cluster

e2e: ## Run end-to-end checks against the local cluster
	scripts/e2e.sh
