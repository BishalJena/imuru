#!/usr/bin/env bash
# Run on the VPS as root. Installs k3s at the same version as the local k3d
# cluster, then cert-manager for Let's Encrypt certificates.
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.36.5+k3s1}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"

curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=300s

if ! command -v helm >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-4 | bash
fi

helm repo add jetstack https://charts.jetstack.io --force-update
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --version "$CERT_MANAGER_VERSION" --set crds.enabled=true --wait

echo "k3s and cert-manager are ready. Next: edit and apply scripts/vps/cluster-issuer.yaml."
