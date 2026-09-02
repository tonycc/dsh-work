#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: run-server.sh DEPLOY_ROOT}
umask 077
runtime_env="${deploy_root}/runtime.env"
current_release="${deploy_root}/current"

if [[ ! -r "${runtime_env}" ]]; then
  echo "runtime environment is not readable: ${runtime_env}" >&2
  exit 1
fi
if [[ ! -d "${current_release}/server/dist" ]]; then
  echo "active server release is missing: ${current_release}" >&2
  exit 1
fi

set -a
# runtime.env is an operator-owned, shell-compatible dotenv file (mode 600).
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

mkdir -p "${DSH_WORK_DATA_ROOT:?Set DSH_WORK_DATA_ROOT}" "${DSH_WORK_DSH_SESSIONS_ROOT:?Set DSH_WORK_DSH_SESSIONS_ROOT}" "${deploy_root}/logs"

node_bin=${DSH_WORK_NODE_BIN:-}
if [[ -z "${node_bin}" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "${candidate}" ]]; then
      node_bin=${candidate}
      break
    fi
  done
fi
if [[ -z "${node_bin}" || ! -x "${node_bin}" ]]; then
  echo "Node.js executable is unavailable; set DSH_WORK_NODE_BIN in runtime.env" >&2
  exit 1
fi

cd "${current_release}"
exec "${node_bin}" server/dist/main.js
