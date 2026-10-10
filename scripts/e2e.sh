#!/usr/bin/env bash
# End-to-end checks against a running cluster. Each check retries briefly:
# freshly scheduled pods can be unreachable for a few seconds while
# NetworkPolicy rules and endpoints sync.
set -euo pipefail

DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
STORE_NS="${STORE_NS:-store}"
STORE_URL="${STORE_URL:-http://store.${DOMAIN}}"
PLATFORM_NS="${PLATFORM_NS:-platform}"
APP_URL="${APP_URL:-http://app.${DOMAIN}}"

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

COOKIES=$(mktemp -d)
trap 'rm -rf "$COOKIES"' EXIT
ADMIN_EMAIL=$(helm get values platform -n "$PLATFORM_NS" --all -o json | json 'd["admin"]["email"]')
ADMIN_PASSWORD=$(kubectl -n "$PLATFORM_NS" get secret gateway -o jsonpath='{.data.admin-password}' | base64 -d)
MEMBER_EMAIL="${MEMBER_EMAIL:-user-b@e2e.test}"
MEMBER_PASSWORD="e2e-member-password"

# api <who> <method> <path> [json]: dashboard API call with that user's cookie.
api() {
  local who=$1 method=$2 path=$3 body=${4:-}
  curl -s -b "$COOKIES/$who" -c "$COOKIES/$who" -X "$method" "$APP_URL/api$path" \
    ${body:+-H 'Content-Type: application/json' -d "$body"}
}

login() { api "$1" POST /auth/login "{\"email\":\"$2\",\"password\":\"$3\"}" | grep -q '"id"'; }

# Invites user B on first run; later runs log in with the same password.
ensure_member() {
  local url token
  login member "$MEMBER_EMAIL" "$MEMBER_PASSWORD" && return 0
  url=$(api admin POST /invites "{\"email\":\"$MEMBER_EMAIL\",\"name\":\"User B\",\"role\":\"member\"}" | json 'd["invite_url"]') || return 1
  token=${url##*/}
  api member POST /invites/accept "{\"token\":\"$token\",\"password\":\"$MEMBER_PASSWORD\"}" | grep -q '"id"'
}

KEY=""
# mcp <session-id|""> <json-rpc body>: POST to the gateway with $KEY; prints the
# JSON-RPC payload (unwrapping SSE framing), or the new session id when none given.
mcp() {
  local sid=$1 body=$2 headers out
  headers=$(mktemp)
  out=$(curl -s -D "$headers" "$APP_URL/mcp" -H "Authorization: Bearer $KEY" \
    ${sid:+-H "Mcp-Session-Id: $sid"} -H 'MCP-Protocol-Version: 2025-06-18' \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$body")
  if [[ -z "$sid" ]]; then
    awk 'tolower($1)=="mcp-session-id:" {print $2}' "$headers" | tr -d '\r'
  else
    sed -n 's/^data: //p' <<<"$out"
  fi
  rm -f "$headers"
}

mcp_session() {
  local sid
  sid=$(mcp "" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')
  [[ -n "$sid" ]] || return 1
  mcp "$sid" '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  echo "$sid"
}

tool_names() { mcp "$1" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | json '" ".join(sorted(t["name"] for t in d["result"]["tools"]))'; }

# call_tool <session> <tool> <arguments json>
call_tool() { mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"; }

server_status() { api admin GET /servers | json "[s['status'] for s in d if s['slug'] == '$1'][0]"; }
server_id() { api admin GET /servers | json "[s['id'] for s in d if s['slug'] == '$1'][0]"; }

echo
echo "gateway ($APP_URL)"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$APP_URL/mcp")" == 401 ]] && ok "/mcp rejects a request without an API key" || ko "/mcp rejects a request without an API key"
retry 10 login admin "$ADMIN_EMAIL" "$ADMIN_PASSWORD" && ok "admin logs in to the dashboard API" || ko "admin logs in to the dashboard API"
retry 3 ensure_member && ok "user B (member) accepted an invite and logged in" || ko "user B (member) accepted an invite and logged in"
KEY=$(api member POST /keys '{"name":"e2e"}' | json 'd["key"]' 2>/dev/null || true)
[[ "$KEY" == urk_* ]] && ok "user B generated their own API key" || ko "user B generated their own API key"
for s in woo everything-a everything-b; do
  retry 20 eval "[[ \$(server_status $s) == connected ]]" && ok "upstream $s is connected" || ko "upstream $s is connected"
done

SID=$(mcp_session || true)
names=$(tool_names "$SID" 2>/dev/null || true)
[[ " $names " == *" woo__list_orders "* && " $names " == *" everything-a__echo "* && " $names " == *" everything-b__echo "* ]] \
  && ok "user B sees every enabled server's tools; echo from both 'everything' servers coexists" \
  || ko "user B sees every enabled server's tools"

check_orders_today() {
  local today
  today=$(call_tool "$SID" woo__get_store_info "{}" | json 'd["result"]["structuredContent"]["today"]') || return 1
  call_tool "$SID" woo__list_orders "{\"date\":\"$today\"}" | json '[o["id"] for o in d["result"]["structuredContent"]["items"]]' | grep -q "${E2E_ORDER:-}"
}
retry 5 check_orders_today && ok "user B: woo__list_orders(today) returns order #${E2E_ORDER:-?}" || ko "user B: orders today returns the e2e order"
[[ "$(call_tool "$SID" everything-a__echo '{"message":"hi"}' | json 'd["result"]["content"][0]["text"]')" == *hi* ]] \
  && ok "calls route to the right server (everything-a__echo)" || ko "calls route to the right server"

# Disable: tools disappear from the list and direct calls are rejected.
EB=$(server_id everything-b)
api admin PATCH "/servers/$EB" '{"enabled":false}' >/dev/null
names=$(tool_names "$SID")
[[ " $names " != *" everything-b__"* && " $names " == *" everything-a__echo "* ]] && ok "disabled server's tools disappear from tools/list" || ko "disabled server's tools disappear"
[[ "$(call_tool "$SID" everything-b__echo '{"message":"x"}' | json 'd["result"]["isError"]')" == True ]] && ok "call to a disabled server is rejected" || ko "call to a disabled server is rejected"
api admin PATCH "/servers/$EB" '{"enabled":true}' >/dev/null
retry 10 eval "[[ \$(server_status everything-b) == connected ]]" && ok "re-enabled server reconnects" || ko "re-enabled server reconnects"

# Kill an upstream pod: the others keep working and it shows as unreachable.
kubectl -n demo-upstreams delete pod -l app.kubernetes.io/name=everything --wait=false >/dev/null
retry 15 eval "[[ \$(server_status everything-a) == unreachable ]]" && ok "killed upstream shows as unreachable" || ko "killed upstream shows as unreachable"
[[ "$(call_tool "$SID" woo__get_store_info "{}" | json 'd["result"].get("isError", False)')" == False ]] && ok "woo keeps working while everything is down" || ko "woo keeps working while everything is down"
retry 40 eval "[[ \$(server_status everything-a) == connected ]]" && ok "upstream recovers when its replacement pod is ready" || ko "upstream recovers when its replacement pod is ready"

# Audit: B's calls are recorded under B.
audit_has() { api admin GET "/audit?limit=200" | json "any(r['user_email']=='$MEMBER_EMAIL' and r['tool']=='$1' and r['outcome']=='$2' for r in d)" | grep -qx True; }
retry 3 audit_has list_orders ok && ok "audit log: user B, woo list_orders, ok" || ko "audit log records user B's call"
retry 3 audit_has echo unknown_tool && ok "audit log: rejected call to the disabled server" || ko "audit log records the rejected call"

# Revoke: the next call is rejected, even inside the open session.
KEY_ID=$(api member GET /keys | json '[k["id"] for k in d if k["revoked_at"] is None][0]')
api admin DELETE "/users/$(api admin GET /users | json "[u['id'] for u in d if u['email']=='$MEMBER_EMAIL'][0]")/keys/$KEY_ID" >/dev/null
status=$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/mcp" -H "Authorization: Bearer $KEY" -H "Mcp-Session-Id: $SID" \
  -H 'MCP-Protocol-Version: 2025-06-18' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/list"}')
[[ "$status" == 401 ]] && ok "admin revoked B's key; B's next call is rejected (401)" || ko "revoked key is rejected" "$status"
api admin GET "/audit?outcome=auth_rejected&limit=50" | json "any(r['user_email']=='$MEMBER_EMAIL' for r in d)" | grep -qx True \
  && ok "audit log: rejected call attributed to user B" || ko "audit log attributes the rejected call to user B"

# tcp_from <namespace> <host> <port>: "open" or "blocked", as seen by a throwaway pod.
tcp_from() {
  local ns=$1 host=$2 port=$3 name="e2e-probe-$RANDOM"
  kubectl -n "$ns" run "$name" --restart=Never --image=busybox:1.37.0 --labels=app.kubernetes.io/name=e2e-probe \
    --command -- sh -c "sleep 3; if nc -z -w 4 $host $port; then echo open; else echo blocked; fi" >/dev/null
  kubectl -n "$ns" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$name" --timeout=90s >/dev/null 2>&1 || true
  kubectl -n "$ns" logs "$name" 2>/dev/null
  kubectl -n "$ns" delete pod "$name" --wait=false >/dev/null 2>&1
}

echo
echo "isolation"
# Positive control first: the probe must be able to see an open port, or "blocked" proves nothing.
[[ "$(tcp_from default "kube-dns.kube-system.svc" 53)" == open ]] && ok "probe sees an open port (kube-dns)" || ko "probe sees an open port (kube-dns)"
[[ "$(tcp_from default "woo-mcp.$STORE_NS.svc" 3000)" == blocked ]] && ok "woo-mcp unreachable from namespace default" || ko "woo-mcp unreachable from namespace default"
[[ "$(tcp_from "$STORE_NS" woo-mcp 3000)" == blocked ]] && ok "woo-mcp unreachable from other pods in $STORE_NS" || ko "woo-mcp unreachable from other pods in $STORE_NS"
[[ "$(tcp_from default "mariadb.$STORE_NS.svc" 3306)" == blocked ]] && ok "mariadb unreachable from namespace default" || ko "mariadb unreachable from namespace default"
[[ "$(tcp_from default "wordpress.$STORE_NS.svc" 80)" == blocked ]] && ok "wordpress reachable only via the Ingress" || ko "wordpress reachable only via the Ingress"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
