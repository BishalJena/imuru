#!/usr/bin/env bash
# End-to-end checks against a running cluster. Each check retries briefly:
# freshly scheduled pods can be unreachable for a few seconds while
# NetworkPolicy rules and endpoints sync.
set -euo pipefail

DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
STORE_NS="${STORE_NS:-store}"
STORE_URL="${STORE_URL:-http://store.${DOMAIN}}"

pass=0
fail=0

ok() { echo "  ok   $1"; pass=$((pass + 1)); }
ko() { echo "  FAIL $1${2:+: $2}"; fail=$((fail + 1)); }

# retry <attempts> <cmd...>: runs cmd until it succeeds, 2s apart.
retry() {
  local n=$1; shift
  for ((i = 1; i <= n; i++)); do
    "$@" && return 0
    sleep 2
  done
  return 1
}

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# woo_get <path>: WooCommerce REST GET signed with OAuth 1.0a, the scheme Woo
# requires over plain HTTP. The signature covers the site's home URL, which is
# the public store URL here.
woo_get() {
  local ck cs
  ck=$(kubectl -n "$STORE_NS" get secret woo-rest -o jsonpath='{.data.consumer-key}' | base64 -d)
  cs=$(kubectl -n "$STORE_NS" get secret woo-rest -o jsonpath='{.data.consumer-secret}' | base64 -d)
  python3 - "$STORE_URL/wp-json/wc/v3$1" "$ck" "$cs" <<'PY'
import base64, hashlib, hmac, secrets, sys, time, urllib.parse, urllib.request
url, ck, cs = sys.argv[1:4]
parts = urllib.parse.urlsplit(url)
base_url = f"{parts.scheme}://{parts.netloc}{parts.path}"
params = dict(urllib.parse.parse_qsl(parts.query))
params.update(oauth_consumer_key=ck, oauth_nonce=secrets.token_hex(16),
              oauth_signature_method="HMAC-SHA256", oauth_timestamp=str(int(time.time())))
enc = lambda s: urllib.parse.quote(str(s), safe="~")
# Woo double-encodes each key=value pair and joins pairs with an encoded "&".
norm = "%26".join(enc(f"{enc(k)}={enc(v)}") for k, v in sorted(params.items()))
base = f"GET&{enc(base_url)}&{norm}"
params["oauth_signature"] = base64.b64encode(
    hmac.new(f"{cs}&".encode(), base.encode(), hashlib.sha256).digest()).decode()
with urllib.request.urlopen(f"{base_url}?{urllib.parse.urlencode(params)}", timeout=15) as r:
    sys.stdout.write(r.read().decode())
PY
}

check_storefront() { [[ "$(curl -s -o /dev/null -w '%{http_code}' "$STORE_URL/")" == 200 ]]; }

check_products() {
  local n
  n=$(curl -sf "$STORE_URL/wp-json/wc/store/v1/products" | json 'len(d)') || return 1
  [[ "$n" -ge 1 ]]
}

# Places a COD order through the Store API (the API the checkout page uses),
# then reads it back through the authenticated admin REST API.
check_cod_order() {
  local api="$STORE_URL/wp-json/wc/store/v1" headers token nonce product order status
  headers=$(mktemp)
  curl -s -D "$headers" -o /dev/null "$api/cart"
  token=$(awk 'tolower($1)=="cart-token:" {print $2}' "$headers" | tr -d '\r')
  nonce=$(awk 'tolower($1)=="nonce:" {print $2}' "$headers" | tr -d '\r')
  rm -f "$headers"
  product=$(curl -sf "$api/products" | json 'd[0]["id"]') || return 1
  curl -sf -X POST "$api/cart/add-item" -H "Cart-Token: $token" -H "Nonce: $nonce" \
    -H 'Content-Type: application/json' -d "{\"id\":$product,\"quantity\":1}" >/dev/null || return 1
  order=$(curl -sf -X POST "$api/checkout" -H "Cart-Token: $token" -H "Nonce: $nonce" \
    -H 'Content-Type: application/json' -d '{
      "payment_method": "cod",
      "billing_address": {"first_name":"E2E","last_name":"Shopper","address_1":"1 Test St","city":"Bhubaneswar","state":"OD","postcode":"751001","country":"IN","email":"e2e@example.com","phone":"9999999999"},
      "shipping_address": {"first_name":"E2E","last_name":"Shopper","address_1":"1 Test St","city":"Bhubaneswar","state":"OD","postcode":"751001","country":"IN"}
    }' | json 'd["order_id"]') || return 1
  status=$(woo_get "/orders/$order" | json 'd["payment_method"] + ":" + d["status"]') || return 1
  E2E_ORDER="$order"
  [[ "$status" == "cod:processing" ]]
}

echo "store ($STORE_URL)"
retry 15 check_storefront && ok "storefront returns 200" || ko "storefront returns 200"
retry 5 check_products && ok "shop lists products" || ko "shop lists products"
retry 3 check_cod_order && ok "COD checkout creates order #${E2E_ORDER} visible to admin API" \
  || ko "COD checkout creates an order visible to admin API"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
