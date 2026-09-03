#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: build-release.sh VERSION [OUTPUT_DIRECTORY]}
[[ "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || { echo "invalid stable release version: ${version}" >&2; exit 1; }

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output_directory=${2:-"${project_root}/dist/releases"}
tag="v${version}"
bundle_name="dsh-work-${tag}"
bundle="${output_directory}/${bundle_name}"
archive="${output_directory}/${bundle_name}.tar.gz"
checksum="${archive}.sha256"
server_stage=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-server-stage.XXXXXX")
output_created=false
build_complete=false

cleanup() {
  rm -rf "${server_stage}"
  if [[ "${output_created}" == true && "${build_complete}" != true ]]; then
    rm -rf "${bundle}"
    rm -f "${archive}" "${checksum}"
  fi
}
trap cleanup EXIT

package_version=$(node -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" "${project_root}/server/package.json")
[[ "${package_version}" == "${version}" ]] \
  || { echo "release version ${version} does not match server/package.json ${package_version}" >&2; exit 1; }

mkdir -p "${output_directory}"
if [[ -e "${bundle}" || -e "${archive}" ]]; then
  echo "release output already exists: ${bundle_name}" >&2
  exit 1
fi

for forbidden_path in \
  "${project_root}/deploy/runtime.env" \
  "${project_root}/deploy/certs"; do
  if [[ -e "${forbidden_path}" ]]; then
    echo "refusing to build beside sensitive deployment material: ${forbidden_path}" >&2
    exit 1
  fi
done

cd "${project_root}"
pnpm build
pnpm --config.inject-workspace-packages=true --filter @dsh-work/server deploy --prod "${server_stage}"
[[ -d "${server_stage}/node_modules" ]] || { echo "server production dependencies were not deployed" >&2; exit 1; }

output_created=true
mkdir -p \
  "${bundle}/server" \
  "${bundle}/server/config/dsh" \
  "${bundle}/apps/workbench-web" \
  "${bundle}/apps/admin-web" \
  "${bundle}/scripts/deploy" \
  "${bundle}/deploy/launchd" \
  "${bundle}/deploy/nginx"

cp "${project_root}/server/package.json" "${bundle}/server/package.json"
cp -R "${project_root}/server/dist" "${bundle}/server/dist"
cp -R "${project_root}/server/migrations" "${bundle}/server/migrations"
cp "${project_root}/server/config/dsh/acp-managed-credentials.cordis.yml" "${bundle}/server/config/dsh/"
cp "${project_root}/server/config/dsh/dsh-work-tool-policy.js" "${bundle}/server/config/dsh/"
cp "${project_root}/server/config/dsh/runtime-lock.json" "${bundle}/server/config/dsh/"
cp -R "${server_stage}/node_modules" "${bundle}/server/node_modules"
cp -R "${project_root}/apps/workbench-web/dist" "${bundle}/apps/workbench-web/dist"
cp -R "${project_root}/apps/admin-web/dist" "${bundle}/apps/admin-web/dist"

deployment_scripts=(
  backup.sh
  init-intranet-ca.sh
  install-launchd.sh
  install-release-watcher.sh
  issue-intranet-ip-certificate.sh
  preflight.sh
  release.sh
  restore.sh
  rollback.sh
  run-server.sh
  watch-release.sh
)
for deployment_script in "${deployment_scripts[@]}"; do
  cp "${project_root}/scripts/deploy/${deployment_script}" "${bundle}/scripts/deploy/"
done

cp "${project_root}/deploy/compose.yaml" "${bundle}/deploy/compose.yaml"
cp "${project_root}/deploy/runtime.env.example" "${bundle}/deploy/runtime.env.example"
cp "${project_root}/deploy/launchd/com.company.dsh-work.server.plist.template" "${bundle}/deploy/launchd/"
cp "${project_root}/deploy/launchd/com.company.dsh-work.release-watcher.plist.template" "${bundle}/deploy/launchd/"
cp "${project_root}/deploy/nginx/default.conf.template" "${bundle}/deploy/nginx/"
cp "${project_root}/deploy/nginx/proxy_params" "${bundle}/deploy/nginx/"

find "${bundle}/scripts/deploy" -type f -name '*.sh' -exec chmod 755 {} +
commit=${GITHUB_SHA:-$(git rev-parse HEAD)}
node "${project_root}/scripts/release/write-release-manifest.mjs" "${bundle}" "${version}" "${commit}"

tar -czf "${archive}" -C "${output_directory}" "${bundle_name}"
(
  cd "${output_directory}"
  shasum -a 256 "${bundle_name}.tar.gz" > "${bundle_name}.tar.gz.sha256"
)

build_complete=true
echo "${archive}"
