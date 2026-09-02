#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: rollback.sh VERSION [DEPLOY_ROOT]}
deploy_root=${2:-${DSH_WORK_DEPLOY_ROOT:-}}
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ -z "${deploy_root}" ]]; then
  deploy_root=$(cd "${script_directory}/../.." && pwd)
fi

if [[ -r "${deploy_root}/active-release" ]]; then
  active_tag=$(<"${deploy_root}/active-release")
  if [[ "${active_tag}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    state_root="${deploy_root}/automation/state"
    mkdir -p "${state_root}"
    printf '%s\n' "${active_tag}" > "${state_root}/blocked-release.new"
    mv "${state_root}/blocked-release.new" "${state_root}/blocked-release"
    echo "automatic redeployment blocked for rolled-back release ${active_tag}"
  fi
fi

exec "${script_directory}/release.sh" "${version}" "${deploy_root}"
