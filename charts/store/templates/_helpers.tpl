{{/* Public hostname of the storefront. */}}
{{- define "store.host" -}}
{{- if .Values.store.hostOverride -}}
{{- .Values.store.hostOverride -}}
{{- else -}}
{{- printf "%s.%s" .Values.store.host .Values.global.domain -}}
{{- end -}}
{{- end -}}

{{- define "store.url" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.global.tls.enabled) (include "store.host" .) -}}
{{- end -}}

{{/* Labels. Call with (dict "ctx" $ "component" "<name>"). */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end -}}

{{- define "store.labels" -}}
{{ include "store.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{- end -}}

{{/*
Base64 value for a generated Secret key. Reuses the value already in the cluster so
upgrades never rotate credentials that are baked into the database.
Call with (dict "ctx" $ "secret" "<name>" "key" "<key>" "value" "<new value>").
*/}}
{{- define "store.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- .value | b64enc -}}
{{- end -}}
{{- end -}}

{{- define "store.storageClass" -}}
{{- if .Values.global.storageClass }}
storageClassName: {{ .Values.global.storageClass }}
{{- end }}
{{- end -}}

{{/* Env shared by WordPress and the WP-CLI Job: wp-config.php reads these at runtime. */}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb:3306
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: mariadb, key: password }
{{- range $k := list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
- name: WORDPRESS_{{ $k }}
  valueFrom:
    secretKeyRef: { name: wordpress, key: {{ $k | lower | replace "_" "-" }} }
{{- end }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
{{- end -}}
