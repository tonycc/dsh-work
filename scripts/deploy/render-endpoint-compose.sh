#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: render-endpoint-compose.sh DEPLOY_ROOT RELEASE_DIR}
release_dir=${2:?Usage: render-endpoint-compose.sh DEPLOY_ROOT RELEASE_DIR}
output_file=${3:-}
runtime_env=${4:-"${deploy_root}/runtime.env"}
[[ -r "${runtime_env}" ]] || { echo "missing ${runtime_env}" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

node_bin=${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}
renderer_arguments=("${deploy_root}" "${release_dir}")
[[ -z "${output_file}" ]] || renderer_arguments+=("${output_file}")
override_file=$("${node_bin}" "${release_dir}/scripts/deploy/render-endpoint-compose.mjs" \
  "${renderer_arguments[@]}")
docker compose --env-file "${runtime_env}" \
  -f "${release_dir}/deploy/compose.yaml" \
  -f "${override_file}" config --quiet
printf '%s\n' "${override_file}"
