#!/usr/bin/env bash
# Multi-store provisioning end to end: two stores created in parallel from the
# API, each registered in the gateway; isolation, guardrails and the
# provisioner's permission limits; then teardown of one store.
set -euo pipefail

DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
APP_URL="${APP_URL:-http://app.${DOMAIN}}"
PLATFORM_NS="${PLATFORM_NS:-platform}"
A="${STORE_A:-north}"
B="${STORE_B:-south}"
SA="system:serviceaccount:${PLATFORM_NS}:provisioner"

pass=0
fail=0
ok() { echo "  ok   $1"; pass=$((pass + 1)); }
ko() { echo "  FAIL $1${2:+: $2}"; fail=$((fail + 1)); }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT
api() { curl -s -b "$COOKIES" -c "$COOKIES" -X "$1" "$APP_URL/api$2" ${3:+-H 'Content-Type: application/json' -d "$3"}; }
ADMIN_EMAIL=$(helm get values platform -n "$PLATFORM_NS" --all -o json | json 'd["admin"]["email"]')
ADMIN_PASSWORD=$(kubectl -n "$PLATFORM_NS" get secret gateway -o jsonpath='{.data.admin-password}' | base64 -d)
api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" >/dev/null

status_of() { api GET /stores | json "next((s['status'] for s in d if s['slug']=='$1'), 'gone')"; }
wait_status() { # <slug> <status> <seconds>
  local end=$(( $(date +%s) + $3 ))
  while (( $(date +%s) < end )); do
    [[ "$(status_of "$1")" == "$2" ]] && return 0
    [[ "$(status_of "$1")" == failed && "$2" != failed ]] && return 1
    sleep 5
  done
  return 1
}
server_status() { api GET /servers | json "next((s['status'] for s in d if s['slug']=='$1'), 'gone')"; }

echo "provision"
api POST /stores "{\"slug\":\"$A\"}" >/dev/null &
api POST /stores "{\"slug\":\"$B\"}" >/dev/null &
wait
[[ "$(status_of "$A")" =~ provisioning|ready && "$(status_of "$B")" =~ provisioning|ready ]] && ok "two stores requested in parallel" || ko "two stores requested"
[[ "$(api POST /stores '{"slug":"third"}' | json 'd["error"]["code"]')" == limit ]] && ok "per-user store limit enforced" || ko "per-user store limit enforced"
wait_status "$A" ready 900 && ok "store $A is Ready" || ko "store $A is Ready" "$(api GET /stores | json "[s.get('reason') for s in d if s['slug']=='$A']")"
wait_status "$B" ready 900 && ok "store $B is Ready" || ko "store $B is Ready" "$(api GET /stores | json "[s.get('reason') for s in d if s['slug']=='$B']")"
URL_A=$(api GET /stores | json "[s['url'] for s in d if s['slug']=='$A'][0]")
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL_A/")" == 200 ]] && ok "storefront $URL_A serves" || ko "storefront $URL_A serves"
for s in "$A" "$B"; do
  for i in $(seq 1 20); do [[ "$(server_status "store-$s")" == connected ]] && break; sleep 3; done
  [[ "$(server_status "store-$s")" == connected ]] && ok "store-$s registered in the gateway and connected" || ko "store-$s registered and connected"
done
tools=$(api GET /servers | json "' '.join(sorted(s['slug']+'__'+t['name'] for s in d for t in s['tools']))")
[[ " $tools " == *" store-${A}__list_orders "* && " $tools " == *" store-${B}__list_orders "* ]] && ok "tool names identify the store (store-${A}__list_orders, store-${B}__list_orders)" || ko "store tools listed"

echo
echo "isolation and guardrails"
tcp_in() {
  kubectl -n "$1" exec deploy/woo-mcp -- node -e "
    const s = require('net').connect({ host: '$2', port: $3, timeout: 4000 });
    s.on('connect', () => { console.log('open'); process.exit(0); });
    s.on('timeout', () => { console.log('blocked'); process.exit(0); });
    s.on('error', () => { console.log('blocked'); process.exit(0); });" 2>/dev/null
}
[[ "$(tcp_in "store-$A" wordpress 80)" == open ]] && ok "store-$A woo-mcp reaches its own WordPress (control)" || ko "own WordPress reachable"
[[ "$(tcp_in "store-$A" "wordpress.store-$B.svc" 80)" == blocked ]] && ok "store-$A woo-mcp cannot reach store-$B WordPress" || ko "cross-store WordPress blocked"
[[ "$(tcp_in "store-$A" "mariadb.store-$B.svc" 3306)" == blocked ]] && ok "store-$A woo-mcp cannot reach store-$B database" || ko "cross-store database blocked"
kubectl -n "store-$A" get resourcequota store-quota >/dev/null 2>&1 && kubectl -n "store-$A" get limitrange store-limits >/dev/null 2>&1 \
  && ok "ResourceQuota and LimitRange in store-$A" || ko "guardrails present"

echo
echo "provisioner permissions"
[[ "$(kubectl auth can-i get secrets -n "$PLATFORM_NS" --as="$SA")" == no ]] && ok "provisioner cannot read platform Secrets" || ko "provisioner cannot read platform Secrets"
[[ "$(kubectl auth can-i get secrets -n "store-$A" --as="$SA")" == yes ]] && ok "provisioner manages Secrets only inside store namespaces" || ko "provisioner store-scoped access"
out=$(kubectl create namespace evil-ns --as="$SA" 2>&1 || true)
[[ "$out" == *"store-* namespaces"* ]] && ok "admission policy blocks a non-store namespace" || ko "admission policy blocks a non-store namespace" "$out"
out=$(kubectl -n "$PLATFORM_NS" create rolebinding sneak --clusterrole=urumi-store-manager --serviceaccount="$PLATFORM_NS:provisioner" --as="$SA" 2>&1 || true)
[[ "$out" == *"RoleBindings in store-*"* ]] && ok "admission policy blocks binding itself into platform" || ko "admission policy blocks rolebinding in platform" "$out"

echo
echo "teardown"
ID_B=$(api GET /stores | json "[s['id'] for s in d if s['slug']=='$B'][0]")
api DELETE "/stores/$ID_B" >/dev/null
for i in $(seq 1 20); do [[ "$(server_status "store-$B")" == gone ]] && break; sleep 3; done
[[ "$(server_status "store-$B")" == gone ]] && ok "store-$B tools deregistered from the gateway" || ko "store-$B tools deregistered"
wait_status "$B" gone 300 && ok "store $B removed from the list" || ko "store $B removed from the list"
kubectl get namespace "store-$B" >/dev/null 2>&1 && ko "namespace store-$B deleted" || ok "namespace store-$B deleted (volumes, Secrets and Ingress with it)"
[[ "$(server_status "store-$A")" == connected ]] && ok "store $A unaffected" || ko "store $A unaffected"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
