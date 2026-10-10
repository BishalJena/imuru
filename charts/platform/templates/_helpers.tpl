{{- define "platform.host" -}}
{{- if .Values.app.hostOverride -}}
{{- .Values.app.hostOverride -}}
{{- else -}}
{{- printf "%s.%s" .Values.app.host .Values.global.domain -}}
{{- end -}}
{{- end -}}

{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
{{- end -}}

{{- define "platform.labels" -}}
{{ include "platform.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{- end -}}

{{/* Reuse an existing generated value so upgrades never rotate it. */}}
{{- define "platform.secretValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key -}}
{{- else -}}
{{- .value | b64enc -}}
{{- end -}}
{{- end -}}

{{- define "platform.upstreamEnvName" -}}
{{- printf "UPSTREAM_%s_CREDENTIAL" (.slug | upper | replace "-" "_") -}}
{{- end -}}

{{/* Seed list for the gateway: everything except the credential values themselves. */}}
{{- define "platform.seedUpstreams" -}}
{{- $out := list -}}
{{- range .Values.upstreams -}}
{{- $u := dict "slug" .slug "name" .name "url" .url "auth" (.auth | default "none") -}}
{{- if .authHeader }}{{- $_ := set $u "authHeader" .authHeader -}}{{- end -}}
{{- if ne (.auth | default "none") "none" }}{{- $_ := set $u "credentialEnv" (include "platform.upstreamEnvName" .) -}}{{- end -}}
{{- if .timeoutMs }}{{- $_ := set $u "timeoutMs" .timeoutMs -}}{{- end -}}
{{- $out = append $out $u -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}
