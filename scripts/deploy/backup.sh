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
off_host_root=${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY:?Set DSH_WORK_OFF_HOST_BACKUP_DIRECTORY in runtime.env}
[[ "${off_host_root}" == /* && "${off_host_root}" != / ]] \
  || { echo "off-host backup directory must be an absolute non-root path" >&2; exit 1; }
[[ -d "${off_host_root}" && ! -L "${off_host_root}" && -w "${off_host_root}" ]] \
  || { echo "off-host backup directory must be a writable mounted directory: ${off_host_root}" >&2; exit 1; }
local_device=$(df -P "${deploy_root}" | awk 'NR==2 {print $1}')
off_host_device=$(df -P "${off_host_root}" | awk 'NR==2 {print $1}')
[[ -n "${local_device}" && -n "${off_host_device}" && "${local_device}" != "${off_host_device}" ]] \
  || { echo "off-host backups must use a filesystem distinct from ${deploy_root}" >&2; exit 1; }

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_root="${deploy_root}/backups"
partial="${backup_root}/.partial-${timestamp}-$$"
target="${backup_root}/${timestamp}"
backup_id="dsh-work-backup-${timestamp}"
off_host_archive="${off_host_root}/${backup_id}.tar.gz"
off_host_checksum="${off_host_archive}.sha256"
off_host_receipt="${off_host_archive}.verified.json"
off_host_partial="${off_host_root}/.${backup_id}.partial-$$"
for backup_path in "${target}" "${off_host_archive}" "${off_host_checksum}" "${off_host_receipt}"; do
  [[ ! -e "${backup_path}" ]] \
    || { echo "refusing to overwrite existing backup material: ${backup_path}" >&2; exit 1; }
done
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
  rm -f "${off_host_partial}" "${off_host_partial}.sha256" "${off_host_partial}.verified.json"
  if [[ "${restart_server}" == true ]]; then
    "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}" || true
  fi
}
trap cleanup EXIT

endpoint_compose=$("${release_dir}/scripts/deploy/render-endpoint-compose.sh" "${deploy_root}" "${release_dir}")
docker compose --env-file "${runtime_env}" -f "${compose_file}" -f "${endpoint_compose}" exec -T postgres \
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

tar -czf "${off_host_partial}" -C "${backup_root}" "${timestamp}"
archive_sha=$(shasum -a 256 "${off_host_partial}" | awk '{print $1}')
printf '%s  %s\n' "${archive_sha}" "${backup_id}.tar.gz" >"${off_host_partial}.sha256"
mv "${off_host_partial}" "${off_host_archive}"
mv "${off_host_partial}.sha256" "${off_host_checksum}"
(
  cd "${off_host_root}"
  shasum -a 256 -c "$(basename "${off_host_checksum}")"
)
current_off_host_device=$(df -P "${off_host_root}" | awk 'NR==2 {print $1}')
[[ -n "${current_off_host_device}" && "${current_off_host_device}" == "${off_host_device}" ]] \
  || { echo "off-host backup filesystem changed while the backup was being written" >&2; exit 1; }
verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat >"${off_host_partial}.verified.json" <<EOF
{
  "schema_version": 1,
  "backup_id": "${backup_id}",
  "created_at": "${verified_at}",
  "verified_at": "${verified_at}",
  "storage_class": "off-host",
  "profile": "dsh-work",
  "archive": "${backup_id}.tar.gz",
  "archive_sha256": "${archive_sha}"
}
EOF
chmod 600 "${off_host_partial}.verified.json"
mv "${off_host_partial}.verified.json" "${off_host_receipt}"
if [[ "${restart_server}" == true ]]; then
  "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}"
  restart_server=false
fi
trap - EXIT
echo "backup created: ${target}"
echo "verified off-host backup receipt: ${off_host_receipt}"
