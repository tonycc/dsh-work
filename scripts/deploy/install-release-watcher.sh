#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: install-release-watcher.sh DEPLOY_ROOT}
runtime_env="${deploy_root}/runtime.env"
label=com.company.dsh-work.release-watcher
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_root=$(cd "${script_directory}/../.." && pwd)
template="${source_root}/deploy/launchd/${label}.plist.template"
source_watcher="${source_root}/scripts/deploy/watch-release.sh"
agents_directory="${HOME}/Library/LaunchAgents"
plist="${agents_directory}/${label}.plist"

[[ -r "${runtime_env}" ]] || { echo "missing ${runtime_env}" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

[[ "$(uname -s)" == Darwin ]] || { echo "release watcher requires macOS" >&2; exit 1; }
[[ "${DSH_WORK_DEPLOY_ROOT:?Set DSH_WORK_DEPLOY_ROOT}" == "${deploy_root}" ]] \
  || { echo "runtime.env DSH_WORK_DEPLOY_ROOT does not match ${deploy_root}" >&2; exit 1; }
[[ "${DSH_WORK_AUTO_DEPLOY_ENABLED:-false}" == true ]] \
  || { echo "set DSH_WORK_AUTO_DEPLOY_ENABLED=true before installing the watcher" >&2; exit 1; }
for command_name in curl gh launchctl plutil; do
  command -v "${command_name}" >/dev/null \
    || { echo "release watcher dependency is unavailable: ${command_name}" >&2; exit 1; }
done
[[ -x "${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN}" ]] \
  || { echo "Node.js is not executable: ${DSH_WORK_NODE_BIN}" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "GitHub CLI is not authenticated" >&2; exit 1; }
runtime_mode=$(stat -f '%Lp' "${runtime_env}")
if (( (8#${runtime_mode} & 8#077) != 0 )); then
  echo "${runtime_env} must have mode 600" >&2
  exit 1
fi
[[ -f "${template}" ]] || { echo "release watcher launchd template is missing: ${template}" >&2; exit 1; }
[[ -r "${source_watcher}" ]] || { echo "release watcher script is missing: ${source_watcher}" >&2; exit 1; }
if [[ "${deploy_root}" == *['&<>|\\']* ]]; then
  echo "deployment root contains unsupported plist or template characters: ${deploy_root}" >&2
  exit 1
fi

poll_interval=${DSH_WORK_RELEASE_POLL_INTERVAL_SECONDS:-300}
[[ "${poll_interval}" =~ ^[0-9]+$ ]] \
  || { echo "DSH_WORK_RELEASE_POLL_INTERVAL_SECONDS must be an integer" >&2; exit 1; }
(( poll_interval >= 300 && poll_interval <= 86400 )) \
  || { echo "release polling interval must be between 300 and 86400 seconds" >&2; exit 1; }

automation_root="${deploy_root}/automation"
mkdir -p "${agents_directory}" "${automation_root}/state" "${deploy_root}/logs"
cp "${source_watcher}" "${automation_root}/watch-release.sh.new"
chmod 700 "${automation_root}/watch-release.sh.new"
mv "${automation_root}/watch-release.sh.new" "${automation_root}/watch-release.sh"

sed \
  -e "s|__DEPLOY_ROOT__|${deploy_root}|g" \
  -e "s|<integer>93000300</integer>|<integer>${poll_interval}</integer>|g" \
  "${template}" > "${plist}.new"
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

echo "automatic public Release watcher installed: ${service_target}"
echo "poll interval: ${poll_interval} seconds"
