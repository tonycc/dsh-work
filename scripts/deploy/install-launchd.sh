#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: install-launchd.sh DEPLOY_ROOT}
label=com.company.dsh-work.server
template="${deploy_root}/current/deploy/launchd/${label}.plist.template"
agents_directory="${HOME}/Library/LaunchAgents"
plist="${agents_directory}/${label}.plist"

if [[ ! -f "${template}" ]]; then
  echo "launchd template is missing: ${template}" >&2
  exit 1
fi
if [[ "${deploy_root}" == *['&<>']* ]]; then
  echo "deployment root cannot contain XML metacharacters: ${deploy_root}" >&2
  exit 1
fi

mkdir -p "${agents_directory}" "${deploy_root}/logs"
sed "s|__DEPLOY_ROOT__|${deploy_root}|g" "${template}" > "${plist}.new"
plutil -lint "${plist}.new" >/dev/null
chmod 600 "${plist}.new"
mv "${plist}.new" "${plist}"

service_target="gui/${UID}/${label}"
if launchctl print "${service_target}" >/dev/null 2>&1; then
  launchctl bootout "${service_target}"
fi
launchctl bootstrap "gui/${UID}" "${plist}"
launchctl enable "${service_target}"
launchctl kickstart -k "${service_target}"
