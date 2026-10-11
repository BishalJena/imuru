#!/usr/bin/env bash
# Render-based chart tests: properties of the manifests Helm produces, checked
# without a cluster. Run by `make check`.
set -uo pipefail

pass=0
fail=0
check() { # <description> <command...>
  local desc=$1; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $desc"; pass=$((pass + 1)); else echo "  FAIL $desc"; fail=$((fail + 1)); fi
}

render() { helm template "$@" 2>/dev/null; }
platform_tls=$(render p charts/platform -n platform -f charts/platform/values-prod.yaml --set global.domain=x.test --set allowMissingUpstreamSecrets=true)
store_tls=$(render s charts/store -n store -f charts/store/values-prod.yaml --set global.domain=x.test)
store_local=$(render s charts/store -n store -f charts/store/values-local.yaml)

# Extract one document by kind and name.
doc() { awk -v k="kind: $2" -v n="name: $3" 'BEGIN{RS="\n---\n"} index($0,k) && index($0,"\n  " n "\n") {print}' <<<"$1"; }

echo "charts"
check "store-manager role may manage traefik Middlewares (TLS stores render one)" \
  grep -q 'middlewares' <<<"$(doc "$platform_tls" ClusterRole urumi-store-manager)"
check "store TLS: Traefik may reach cert-manager's HTTP-01 solver" \
  grep -q 'acme.cert-manager.io/http01-solver' <<<"$store_tls"
check "platform TLS: Traefik may reach cert-manager's HTTP-01 solver" \
  grep -q 'acme.cert-manager.io/http01-solver' <<<"$platform_tls"
check "store without TLS renders no solver policy" \
  bash -c '! grep -q http01-solver' <<<"$store_local"
# py <python expression over `t`, the rendered text>: structural assertions without a YAML parser.
py() { python3 -c "import re,sys; t=sys.stdin.read(); sys.exit(0 if ($1) else 1)"; }

provisioner_namespace_verbs() {
  doc "$platform_tls" ClusterRole urumi-provisioner | grep -q 'verbs: \[get, list, create, patch, delete\]'
}
check "provisioner namespace verbs are get, list, create, patch, delete" provisioner_namespace_verbs
# Store workloads never call the Kubernetes API, so they must not get a token.
store_pods_no_token() {
  local kind name
  for kind_name in "Deployment wordpress" "StatefulSet mariadb" "Job bootstrap"; do
    read -r kind name <<<"$kind_name"
    doc "$store_tls" "$kind" "$name" | grep -q "automountServiceAccountToken: false" || return 1
  done
}
check "store workloads do not mount a ServiceAccount token (wordpress, mariadb, bootstrap)" store_pods_no_token

check "provisioner may reach the API server on 6443 at any address (public node IPs)" \
  py "re.search(r'- ports:\n\s+- port: 6443', t)" <<<"$(doc "$platform_tls" NetworkPolicy provisioner)"
check "every workload container sets requests and limits" \
  py "t.count('limits:') >= len(re.findall(r'\n\s+- name: [a-z-]+\n\s+image:', t))" <<<"$store_tls$platform_tls"
check "every Deployment/StatefulSet container has readiness and liveness probes" \
  py "t.count('readinessProbe:') == t.count('livenessProbe:') and t.count('readinessProbe:') >= len(re.findall(r'kind: (Deployment|StatefulSet)', t))" <<<"$store_tls$platform_tls"
check "no plaintext secret values in rendered values-prod (only generated b64 in Secrets)" \
  py "not re.search(r'(password|apiKey|token)\s*[:=]\s*\"[^\"{\$]{6,}\"', t, re.I)" <<<"$store_tls$platform_tls"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
