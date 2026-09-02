#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: preflight.sh DEPLOY_ROOT RELEASE_DIR}
release_dir=${2:?Usage: preflight.sh DEPLOY_ROOT RELEASE_DIR}
runtime_env="${deploy_root}/runtime.env"

fail() {
  echo "preflight failed: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail "dsh-work host deployment requires macOS"
[[ "$(uname -m)" == arm64 ]] || fail "the supported Mac mini target is Apple Silicon (arm64)"
[[ -r "${runtime_env}" ]] || fail "missing ${runtime_env}"

set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

for command_name in docker git curl gh shasum launchctl openssl plutil; do
  command -v "${command_name}" >/dev/null || fail "required command is unavailable: ${command_name}"
done
gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not authenticated"
gh release verify --help >/dev/null 2>&1 || fail "GitHub CLI does not support immutable Release verification"
gh attestation verify --help | grep -F -- '--deny-self-hosted-runners' >/dev/null \
  || fail "GitHub CLI does not support the required provenance policy"
docker info >/dev/null 2>&1 || fail "Docker Desktop is not running"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable"

node_bin=${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}
[[ -x "${node_bin}" ]] || fail "Node.js is not executable: ${node_bin}"
node_supported=$("${node_bin}" -p "const [major,minor]=process.versions.node.split('.').map(Number); String((major===22&&minor>=19)||major>=24)")
[[ "${node_supported}" == true ]] || fail "Node.js 22.19+ or 24+ is required"

[[ "${NODE_ENV:-}" == production ]] || fail "NODE_ENV must be production"
[[ "${DSH_WORK_AUTH_MODE:-}" == oidc ]] || fail "DSH_WORK_AUTH_MODE must be oidc"
[[ "${DSH_WORK_COOKIE_SECURE:-}" == true ]] || fail "secure cookies are mandatory"
[[ "${DSH_WORK_SERVER_HOST:-}" == 127.0.0.1 ]] || fail "the native server must bind only to 127.0.0.1"

for required_path in \
  "${release_dir}/release.json" \
  "${release_dir}/server/dist/main.js" \
  "${release_dir}/server/dist/modules/identity/config.js" \
  "${release_dir}/server/dist/modules/runtime/dsh-runtime-installation.js" \
  "${release_dir}/server/dist/infrastructure/postgres/migrate.js" \
  "${release_dir}/server/migrations" \
  "${release_dir}/server/config/dsh/runtime-lock.json" \
  "${release_dir}/apps/workbench-web/dist/index.html" \
  "${release_dir}/apps/admin-web/dist/index.html" \
  "${release_dir}/deploy/compose.yaml"; do
  [[ -e "${required_path}" ]] || fail "release payload is incomplete: ${required_path}"
done

if ! (
  cd "${release_dir}"
  "${node_bin}" --input-type=module -e \
    "const { loadIdentityConfiguration } = await import('./server/dist/modules/identity/config.js'); loadIdentityConfiguration()"
); then
  fail "AI Hub OIDC production configuration is invalid"
fi

if ! "${node_bin}" -e '
  const url = new URL(process.env.DSH_WORK_DATABASE_URL ?? "")
  const expected = {
    host: "127.0.0.1",
    port: process.env.DSH_WORK_POSTGRES_PORT ?? "5434",
    user: process.env.DSH_WORK_POSTGRES_USER,
    password: process.env.DSH_WORK_POSTGRES_PASSWORD,
    database: process.env.DSH_WORK_POSTGRES_DB,
  }
  const actual = {
    host: url.hostname,
    port: url.port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  }
  if (Object.keys(expected).some(key => actual[key] !== expected[key])) process.exit(1)
'; then
  fail "DSH_WORK_DATABASE_URL does not match the local PostgreSQL settings"
fi

[[ -r "${DSH_WORK_TLS_CERT_FILE:?Set DSH_WORK_TLS_CERT_FILE}" ]] || fail "TLS certificate is unreadable"
[[ -r "${DSH_WORK_TLS_KEY_FILE:?Set DSH_WORK_TLS_KEY_FILE}" ]] || fail "TLS private key is unreadable"
[[ -r "${DSH_WORK_CA_CERT_FILE:?Set DSH_WORK_CA_CERT_FILE}" ]] || fail "internal CA certificate is unreadable"
openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -checkend 86400 >/dev/null || fail "TLS certificate expires in less than 24 hours"
openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -text | grep -F "IP Address:${DSH_WORK_PUBLIC_HOST:?Set DSH_WORK_PUBLIC_HOST}" >/dev/null \
  || fail "TLS certificate does not contain the configured private IP SAN"

runtime_home=${DSH_RUNTIME_HOME:?Set DSH_RUNTIME_HOME in runtime.env}
runtime_is_worktree=$(git -C "${runtime_home}" rev-parse --is-inside-work-tree 2>/dev/null) \
  || fail "DSH_RUNTIME_HOME is not a Git checkout or worktree: ${runtime_home}"
[[ "${runtime_is_worktree}" == true ]] \
  || fail "DSH_RUNTIME_HOME is not a Git checkout or worktree: ${runtime_home}"
locked_version=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" \
  "${release_dir}/server/config/dsh/runtime-lock.json")
locked_commit=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.commit ?? '')" \
  "${release_dir}/server/config/dsh/runtime-lock.json")
[[ "${locked_version}" == "${DSH_EXPECTED_VERSION:?Set DSH_EXPECTED_VERSION}" ]] \
  || fail "release DSH version lock does not match runtime.env"
[[ "${locked_commit}" == "${DSH_EXPECTED_COMMIT:?Set DSH_EXPECTED_COMMIT}" ]] \
  || fail "release DSH commit lock does not match runtime.env"
actual_commit=$(git -C "${runtime_home}" rev-parse HEAD)
[[ "${actual_commit}" == "${locked_commit}" ]] || fail "installed DSH commit does not match the release lock"
actual_version=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" "${runtime_home}/package.json")
[[ "${actual_version}" == "${locked_version}" ]] || fail "installed DSH version does not match the release lock"
[[ -r "${runtime_home}/packages/examples/acp-demo/src/bin.ts" ]] || fail "DSH ACP source entry is missing"
[[ -d "${runtime_home}/node_modules/tsx" ]] || fail "DSH dependencies are not installed"
[[ -r "${runtime_home}/packages/examples/acp-demo/lib/bin.js" ]] || fail "DSH build output is missing; run its locked build"
if [[ -n "$(git -C "${runtime_home}" status --porcelain --untracked-files=no)" ]]; then
  fail "DSH tracked files are modified; production requires the locked clean checkout"
fi

dsh_preflight_root=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-deploy-preflight.XXXXXX")
if ! (
  cd "${release_dir}"
  "${node_bin}" --input-type=module -e '
    const { preflightDshRuntime, resolveDshRuntimeInstallation } = await import(
      "./server/dist/modules/runtime/dsh-runtime-installation.js"
    )
    const env = {
      ...process.env,
      DSH_WORK_DATA_ROOT: process.argv[2],
      DSH_WORK_DSH_SESSIONS_ROOT: process.argv[3],
    }
    const installation = await resolveDshRuntimeInstallation({ projectRoot: process.argv[1], env })
    await preflightDshRuntime(installation)
  ' "${release_dir}" "${dsh_preflight_root}" "${dsh_preflight_root}/sessions"
); then
  rm -rf "${dsh_preflight_root}"
  fail "installed DSH failed the ACP startup handshake"
fi
rm -rf "${dsh_preflight_root}"

runtime_mode=$(stat -f '%Lp' "${runtime_env}")
if (( (8#${runtime_mode} & 8#077) != 0 )); then
  fail "${runtime_env} must not be readable or writable by group/others; run chmod 600"
fi

available_kib=$(df -Pk "${deploy_root}" | awk 'NR==2 {print $4}')
(( available_kib >= 5 * 1024 * 1024 )) || fail "at least 5 GiB free disk space is required"

echo "preflight passed for ${release_dir}"
