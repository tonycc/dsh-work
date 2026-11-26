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
# launchctl bootout returns before the job has fully left the domain. Bootstrapping during that
# window fails with "Bootstrap failed: 5: Input/output error" (seen on 2026-11-26 after migrations
# had already been applied, which leaves the service stopped). Wait for the job to disappear and
# retry the bootstrap a bounded number of times instead of failing on the first race.
unload_wait_seconds=${DSH_WORK_LAUNCHD_UNLOAD_WAIT_SECONDS:-30}
bootstrap_attempts=${DSH_WORK_LAUNCHD_BOOTSTRAP_ATTEMPTS:-5}
retry_delay_seconds=${DSH_WORK_LAUNCHD_RETRY_DELAY_SECONDS:-2}

if launchctl print "${service_target}" >/dev/null 2>&1; then
  launchctl bootout "${service_target}" || true
  deadline=$((SECONDS + unload_wait_seconds))
  while launchctl print "${service_target}" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo "launchd job ${service_target} is still loaded ${unload_wait_seconds}s after bootout" >&2
      exit 1
    fi
    sleep 1
  done
fi

attempt=1
until launchctl bootstrap "gui/${UID}" "${plist}"; do
  if ((attempt >= bootstrap_attempts)); then
    echo "launchd bootstrap of ${plist} failed after ${attempt} attempts" >&2
    exit 1
  fi
  echo "launchd bootstrap attempt ${attempt}/${bootstrap_attempts} failed; retrying in ${retry_delay_seconds}s" >&2
  attempt=$((attempt + 1))
  sleep "${retry_delay_seconds}"
done
launchctl enable "${service_target}"
launchctl kickstart -k "${service_target}"
