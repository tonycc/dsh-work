#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: backup.sh DEPLOY_ROOT [RELEASE_DIR]}
release_dir=${2:-"${deploy_root}/current"}
runtime_env="${deploy_root}/runtime.env"
umask 077

[[ -r "${runtime_env}" ]] || { echo "missing ${runtime_env}" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

compose_file="${release_dir}/deploy/compose.yaml"
[[ -f "${compose_file}" ]] || { echo "missing Compose file: ${compose_file}" >&2; exit 1; }

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_root="${deploy_root}/backups"
partial="${backup_root}/.partial-${timestamp}-$$"
target="${backup_root}/${timestamp}"
mkdir -p "${partial}" "${DSH_WORK_DATA_ROOT:?Set DSH_WORK_DATA_ROOT}"

label=com.company.dsh-work.server
service_target="gui/${UID}/${label}"
restart_server=false
if launchctl print "${service_target}" >/dev/null 2>&1; then
  launchctl bootout "${service_target}"
  restart_server=true
fi

cleanup() {
  if [[ -d "${partial}" ]]; then
    rm -rf "${partial}"
  fi
  if [[ "${restart_server}" == true ]]; then
    "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}" || true
  fi
}
trap cleanup EXIT

docker compose --env-file "${runtime_env}" -f "${compose_file}" exec -T postgres \
  pg_dump --format=custom --no-owner --no-acl \
  --username "${DSH_WORK_POSTGRES_USER:?Set DSH_WORK_POSTGRES_USER}" \
  "${DSH_WORK_POSTGRES_DB:?Set DSH_WORK_POSTGRES_DB}" > "${partial}/database.dump"

data_parent=$(dirname "${DSH_WORK_DATA_ROOT}")
data_name=$(basename "${DSH_WORK_DATA_ROOT}")
tar -czf "${partial}/data.tar.gz" -C "${data_parent}" "${data_name}"
cp "${release_dir}/release.json" "${partial}/release.json"
(
  cd "${partial}"
  shasum -a 256 database.dump data.tar.gz release.json > SHA256SUMS
)
mv "${partial}" "${target}"
if [[ "${restart_server}" == true ]]; then
  "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}"
  restart_server=false
fi
trap - EXIT
echo "backup created: ${target}"
