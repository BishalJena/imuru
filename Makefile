CLUSTER := urumi
# Local targets always address the k3d cluster, whatever the current kubectl context is.
KUBE_CONTEXT ?= k3d-$(CLUSTER)
export KUBE_CONTEXT
K3D_CONFIG := scripts/k3d-config.yaml
HELM_TIMEOUT := 15m
# Content hash of each image's inputs: unchanged code keeps its tag, changed code gets a new one,
# so `helm upgrade` only restarts what changed.
src_hash = $(shell cat $$(git ls-files -co --exclude-standard $(1) pnpm-lock.yaml tsconfig.base.json | sort) | shasum | cut -c1-12)
WOO_MCP_TAG := $(call src_hash,apps/woo-mcp)
GATEWAY_TAG := $(call src_hash,apps/gateway)
DASHBOARD_TAG := $(call src_hash,apps/dashboard)
PROVISIONER_TAG := $(call src_hash,apps/provisioner charts/store)
EVERYTHING_TAG := 2026.8.31

.PHONY: help install typecheck lint test check cluster-up cluster-down deploy-store deploy-upstreams deploy-platform deploy-local push deploy-prod helm-lint e2e images

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
	kubectl --context $(KUBE_CONTEXT) wait --for=condition=Ready nodes --all --timeout=120s

cluster-down: ## Delete the local k3d cluster and all its data
	k3d cluster delete $(CLUSTER)

helm-lint: ## Lint every chart with its local values
	@for c in charts/*/; do helm lint $$c -f $$c/values-local.yaml --set allowMissingUpstreamSecrets=true || exit 1; done

images: ## Build app images and import them into the k3d cluster
	docker build -f apps/woo-mcp/Dockerfile -t urumi/woo-mcp:$(WOO_MCP_TAG) .
	docker build -f apps/gateway/Dockerfile -t urumi/gateway:$(GATEWAY_TAG) .
	docker build -f apps/dashboard/Dockerfile -t urumi/dashboard:$(DASHBOARD_TAG) .
	docker build -f apps/provisioner/Dockerfile -t urumi/provisioner:$(PROVISIONER_TAG) .
	docker build -f images/everything/Dockerfile -t urumi/everything:$(EVERYTHING_TAG) images/everything
	k3d image import -c $(CLUSTER) urumi/woo-mcp:$(WOO_MCP_TAG) urumi/gateway:$(GATEWAY_TAG) urumi/dashboard:$(DASHBOARD_TAG) urumi/provisioner:$(PROVISIONER_TAG) urumi/everything:$(EVERYTHING_TAG)

deploy-store: ## Install or upgrade the store release (namespace store)
	helm upgrade --install --kube-context $(KUBE_CONTEXT) store charts/store -n store --create-namespace \
		-f charts/store/values-local.yaml --set wooMcp.image.tag=$(WOO_MCP_TAG) \
		--wait --timeout $(HELM_TIMEOUT)

deploy-upstreams: ## Install or upgrade the in-cluster demo MCP servers (namespace demo-upstreams)
	helm upgrade --install --kube-context $(KUBE_CONTEXT) demo-upstreams charts/demo-upstreams -n demo-upstreams --create-namespace \
		-f charts/demo-upstreams/values-local.yaml --wait --timeout $(HELM_TIMEOUT)

# Optional secrets (e.g. llm.apiKey) live in a gitignored file.
PLATFORM_SECRETS := $(wildcard charts/platform/values-secrets.local.yaml)

deploy-platform: ## Install or upgrade the platform release (namespace platform)
	helm upgrade --install --kube-context $(KUBE_CONTEXT) platform charts/platform -n platform --create-namespace \
		-f charts/platform/values-local.yaml $(if $(PLATFORM_SECRETS),-f $(PLATFORM_SECRETS)) \
		--set gateway.image.tag=$(GATEWAY_TAG) --set dashboard.image.tag=$(DASHBOARD_TAG) \
		--set provisioner.image.tag=$(PROVISIONER_TAG) --set provisioner.wooMcpImage.tag=$(WOO_MCP_TAG) \
		--wait --timeout $(HELM_TIMEOUT)

deploy-local: images deploy-store deploy-upstreams deploy-platform ## Build images and deploy everything to the local cluster

e2e: ## Run end-to-end checks against the local cluster
	scripts/e2e.sh

e2e-stores: ## Multi-store provisioning end to end (several minutes)
	scripts/e2e-stores.sh

# --- Production-like (k3s VPS) ---------------------------------------------
# REGISTRY: image registry prefix, e.g. ghcr.io/<github-user>/urumi
# DOMAIN:   base domain whose *.DOMAIN points at the VPS, e.g. 203.0.113.10.sslip.io
REGISTRY ?=
DOMAIN ?=
# Extra helm flags for every release, e.g. --set global.tls.clusterIssuer=...
PROD_EXTRA ?=
PLATFORMS ?= linux/amd64,linux/arm64

push: ## Build multi-arch images and push them to $(REGISTRY)
	@test -n "$(REGISTRY)" || (echo "set REGISTRY=ghcr.io/<user>/urumi" && exit 1)
	docker buildx build --platform $(PLATFORMS) -f apps/woo-mcp/Dockerfile -t $(REGISTRY)/woo-mcp:$(WOO_MCP_TAG) --push .
	docker buildx build --platform $(PLATFORMS) -f apps/gateway/Dockerfile -t $(REGISTRY)/gateway:$(GATEWAY_TAG) --push .
	docker buildx build --platform $(PLATFORMS) -f apps/dashboard/Dockerfile -t $(REGISTRY)/dashboard:$(DASHBOARD_TAG) --push .
	docker buildx build --platform $(PLATFORMS) -f apps/provisioner/Dockerfile -t $(REGISTRY)/provisioner:$(PROVISIONER_TAG) --push .
	docker buildx build --platform $(PLATFORMS) -f images/everything/Dockerfile -t $(REGISTRY)/everything:$(EVERYTHING_TAG) --push images/everything

PROD_SECRETS := $(wildcard charts/platform/values-secrets.prod.yaml)

deploy-prod: ## Deploy all charts with values-prod.yaml to the current kube context
	@test -n "$(REGISTRY)" -a -n "$(DOMAIN)" || (echo "set REGISTRY=... DOMAIN=..." && exit 1)
	helm upgrade --install store charts/store -n store --create-namespace -f charts/store/values-prod.yaml \
		--set global.domain=$(DOMAIN) --set wooMcp.image.repository=$(REGISTRY)/woo-mcp --set wooMcp.image.tag=$(WOO_MCP_TAG) \
		$(PROD_EXTRA) --wait --timeout $(HELM_TIMEOUT)
	helm upgrade --install demo-upstreams charts/demo-upstreams -n demo-upstreams --create-namespace -f charts/demo-upstreams/values-prod.yaml \
		--set everything.image.repository=$(REGISTRY)/everything $(PROD_EXTRA) --wait --timeout $(HELM_TIMEOUT)
	helm upgrade --install platform charts/platform -n platform --create-namespace -f charts/platform/values-prod.yaml \
		$(if $(PROD_SECRETS),-f $(PROD_SECRETS)) --set global.domain=$(DOMAIN) \
		--set gateway.image.repository=$(REGISTRY)/gateway --set gateway.image.tag=$(GATEWAY_TAG) \
		--set dashboard.image.repository=$(REGISTRY)/dashboard --set dashboard.image.tag=$(DASHBOARD_TAG) \
		--set provisioner.image.repository=$(REGISTRY)/provisioner --set provisioner.image.tag=$(PROVISIONER_TAG) \
		--set provisioner.wooMcpImage.repository=$(REGISTRY)/woo-mcp --set provisioner.wooMcpImage.tag=$(WOO_MCP_TAG) \
		$(PROD_EXTRA) --wait --timeout $(HELM_TIMEOUT)
