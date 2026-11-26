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
# Validate before touching launchd: a malformed value must not boot the running job out and then
# abort (outage), nor turn the bounded retry loop into an endless one.
for setting in \
  "DSH_WORK_LAUNCHD_UNLOAD_WAIT_SECONDS=${unload_wait_seconds}" \
  "DSH_WORK_LAUNCHD_BOOTSTRAP_ATTEMPTS=${bootstrap_attempts}" \
  "DSH_WORK_LAUNCHD_RETRY_DELAY_SECONDS=${retry_delay_seconds}"; do
  value=${setting#*=}
  if [[ ! "${value}" =~ ^[0-9]{1,4}$ ]]; then
    echo "${setting%%=*} must be a whole number of at most 4 digits: ${value}" >&2
    exit 1
  fi
done
if ((10#${bootstrap_attempts} < 1)); then
  echo "DSH_WORK_LAUNCHD_BOOTSTRAP_ATTEMPTS must be at least 1" >&2
  exit 1
fi
unload_wait_seconds=$((10#${unload_wait_seconds}))
bootstrap_attempts=$((10#${bootstrap_attempts}))
retry_delay_seconds=$((10#${retry_delay_seconds}))

if launchctl print "${service_target}" >/dev/null 2>&1; then
  # bootout can report an error for a job that is already going away; the unload wait below is
  # what decides success, but keep the status so a real failure is not reported as a slow unload.
  bootout_status=0
  launchctl bootout "${service_target}" || bootout_status=$?
  deadline=$((SECONDS + unload_wait_seconds))
  while launchctl print "${service_target}" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo "launchd job ${service_target} is still loaded ${unload_wait_seconds}s after bootout (bootout exit status ${bootout_status})" >&2
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
