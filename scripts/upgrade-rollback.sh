#!/usr/bin/env bash
# Rehearses a Helm upgrade and rollback of the store release: a values change
# (store title and a product price) rolls out and is visible on the
# storefront, then the rollback restores both, while the data on the volumes
# (products, orders) is untouched. Exits non-zero if any check fails.
set -euo pipefail

# Address the intended cluster explicitly (make exports KUBE_CONTEXT for local runs).
kubectl() { command kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} "$@"; }
helm() { command helm ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} "$@"; }

NS="${STORE_NS:-store}"
URL="${STORE_URL:-http://store.127.0.0.1.nip.io}"
SKU="${SKU:-DEMO-TEE}"

title() { curl -s "$URL/" | sed -n 's:.*<title>\(.*\)</title>.*:\1:p' | head -1; }
count() { curl -s "$URL/wp-json/wc/store/v1/products?per_page=100" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
# Store API prices are in minor units (49900 = 499.00).
price() {
  curl -s "$URL/wp-json/wc/store/v1/products?per_page=100" |
    python3 -c "import json,sys; print(next((p['prices']['regular_price'] for p in json.load(sys.stdin) if p['sku']=='$SKU'), 'missing'))"
}
state() { echo "title: $(title) | $SKU price: $(price) | products: $(count)"; }
step() { printf '\n== %s\n' "$*"; }
fail=0
expect() { # <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fail=1; fi
}

step "current state"
helm history store -n "$NS" --max 3
before_rev=$(helm history store -n "$NS" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["revision"])')
before_title=$(title)
before_price=$(price)
before_count=$(count)
state

step "upgrade: change the store title and the $SKU price through values"
# Start from the release's full current values (image tags, domain, product
# list) and change only the title and one price; `--set` on a list index would
# replace the whole list.
values=$(mktemp)
trap 'rm -f "$values"' EXIT
helm get values store -n "$NS" --all -o json |
  python3 -c "
import json, sys
v = json.load(sys.stdin)
v['store']['title'] = 'Urumi Demo Store (upgraded)'
for p in v['store']['products']:
    if p['sku'] == '$SKU':
        p['price'] = '599'
json.dump(v, sys.stdout)" >"$values"
helm upgrade store charts/store -n "$NS" -f "$values" --wait --timeout 10m >/dev/null
state
expect "upgraded title is live" "$(title)" "Urumi Demo Store (upgraded)"
expect "upgraded price is live" "$(price)" "59900"
expect "no products lost or duplicated" "$(count)" "$before_count"

step "rollback to revision $before_rev"
helm rollback store "$before_rev" -n "$NS" --wait --timeout 10m
state
expect "title restored" "$(title)" "$before_title"
expect "price restored" "$(price)" "$before_price"
expect "no products lost or duplicated" "$(count)" "$before_count"

step "history"
helm history store -n "$NS" --max 4
exit "$fail"
