#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: restore.sh DEPLOY_ROOT BACKUP_DIR --confirm}
backup_dir=${2:?Usage: restore.sh DEPLOY_ROOT BACKUP_DIR --confirm}
confirmation=${3:-}
umask 077
[[ "${confirmation}" == --confirm ]] || { echo "restore is destructive; repeat with --confirm" >&2; exit 1; }

runtime_env="${deploy_root}/runtime.env"
release_dir="${deploy_root}/current"
compose_file="${release_dir}/deploy/compose.yaml"
[[ -r "${runtime_env}" ]] || { echo "missing ${runtime_env}" >&2; exit 1; }
[[ -f "${backup_dir}/SHA256SUMS" ]] || { echo "invalid backup: ${backup_dir}" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

recover_service() {
  "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}" >/dev/null 2>&1 || true
  docker compose --env-file "${runtime_env}" -f "${compose_file}" up -d --force-recreate web >/dev/null 2>&1 || true
}
maintenance_started=false
destructive_started=false
restore_complete=false
cleanup() {
  if [[ "${restore_complete}" == true || "${maintenance_started}" != true ]]; then
    return
  fi
  if [[ "${destructive_started}" == true ]]; then
    label=com.company.dsh-work.server
    service_target="gui/${UID}/${label}"
    if launchctl print "${service_target}" >/dev/null 2>&1; then
      launchctl bootout "${service_target}" >/dev/null 2>&1 || true
    fi
    docker compose --env-file "${runtime_env}" -f "${compose_file}" stop web >/dev/null 2>&1 || true
    echo "restore failed after database replacement began; services remain stopped so partial data is not exposed" >&2
  else
    recover_service
  fi
}

(
  cd "${backup_dir}"
  shasum -a 256 -c SHA256SUMS
)

label=com.company.dsh-work.server
service_target="gui/${UID}/${label}"
maintenance_started=true
trap cleanup EXIT
if launchctl print "${service_target}" >/dev/null 2>&1; then
  launchctl bootout "${service_target}"
fi
docker compose --env-file "${runtime_env}" -f "${compose_file}" stop web

destructive_started=true
docker compose --env-file "${runtime_env}" -f "${compose_file}" exec -T postgres \
  dropdb --if-exists --force --username "${DSH_WORK_POSTGRES_USER}" "${DSH_WORK_POSTGRES_DB}"
docker compose --env-file "${runtime_env}" -f "${compose_file}" exec -T postgres \
  createdb --username "${DSH_WORK_POSTGRES_USER}" "${DSH_WORK_POSTGRES_DB}"
docker compose --env-file "${runtime_env}" -f "${compose_file}" exec -T postgres \
  pg_restore --exit-on-error --no-owner --no-acl \
  --username "${DSH_WORK_POSTGRES_USER}" --dbname "${DSH_WORK_POSTGRES_DB}" < "${backup_dir}/database.dump"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -e "${DSH_WORK_DATA_ROOT}" ]]; then
  mv "${DSH_WORK_DATA_ROOT}" "${DSH_WORK_DATA_ROOT}.before-restore-${timestamp}"
fi
tar -xzf "${backup_dir}/data.tar.gz" -C "$(dirname "${DSH_WORK_DATA_ROOT}")"

"${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}"
docker compose --env-file "${runtime_env}" -f "${compose_file}" up -d --wait --force-recreate web
restore_complete=true
trap - EXIT
echo "restore completed from ${backup_dir}; previous data was retained beside DSH_WORK_DATA_ROOT"
