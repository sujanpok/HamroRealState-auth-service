{{- define "room-mgmt-service.name" -}}
room-mgmt-service
{{- end }}

{{- define "room-mgmt-service.fullname" -}}
{{ include "room-mgmt-service.name" . }}
{{- end }}
