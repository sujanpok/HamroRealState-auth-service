{{/* Fullname with color */}}
{{- define "auth-service.fullname" -}}
{{- .Release.Name }}-{{ .Values.color | default "blue" -}}
{{- end -}}

{{/* Name */}}
{{- define "auth-service.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{/* Labels */}}
{{- define "auth-service.labels" -}}
app: {{ include "auth-service.name" . }}
color: {{ .Values.color | default "blue" }}
{{- end -}}

{{/* Selector labels */}}
{{- define "auth-service.selectorLabels" -}}
app: {{ include "auth-service.name" . }}
color: {{ .Values.color | default "blue" }}
{{- end -}}
