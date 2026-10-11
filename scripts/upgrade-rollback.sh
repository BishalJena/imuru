#!/usr/bin/env bash
# Rehearses a Helm upgrade and rollback of the store release: a values change
# rolls out, is visible on the storefront, and is rolled back, while the data
# on the volumes (products, orders) is untouched by both.
set -euo pipefail

# Address the intended cluster explicitly (make exports KUBE_CONTEXT for local runs).
kubectl() { command kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} "$@"; }
helm() { command helm ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} "$@"; }

NS="${STORE_NS:-store}"
URL="${STORE_URL:-http://store.127.0.0.1.nip.io}"
VALUES=(-f charts/store/values-local.yaml --set "wooMcp.image.tag=$(helm get values store -n "$NS" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["wooMcp"]["image"]["tag"])')")

title() { curl -s "$URL/" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p' | head -1; }
orders() { curl -s "$URL/wp-json/wc/store/v1/products" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }

step() { printf '\n== %s\n' "$*"; }

step "current state"
helm history store -n "$NS" --max 3
before_rev=$(helm history store -n "$NS" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["revision"])')
echo "title: $(title) | products: $(orders)"

step "upgrade: change the store title through values"
helm upgrade store charts/store -n "$NS" "${VALUES[@]}" --set store.title="Urumi Demo Store (upgraded)" --wait --timeout 10m >/dev/null
echo "title: $(title) | products: $(orders)"

step "rollback to revision $before_rev"
helm rollback store "$before_rev" -n "$NS" --wait --timeout 10m
echo "title: $(title) | products: $(orders)"

step "history"
helm history store -n "$NS" --max 4
