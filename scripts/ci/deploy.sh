#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${project_root}"

deployment_scripts=(
  scripts/deploy/backup.sh
  scripts/deploy/generate-ip-certificate.sh
  scripts/deploy/install-launchd.sh
  scripts/deploy/install-release-watcher.sh
  scripts/deploy/preflight.sh
  scripts/deploy/release.sh
  scripts/deploy/restore.sh
  scripts/deploy/rollback.sh
  scripts/deploy/run-server.sh
  scripts/deploy/watch-release.sh
  scripts/release/build-release.sh
)

for script in "${deployment_scripts[@]}"; do
  bash -n "${script}"
done

node scripts/ci/release-watcher.test.mjs
node scripts/ci/deployment-safety.test.mjs

docker compose --env-file deploy/runtime.env.example -f deploy/compose.yaml config >/dev/null
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.server.plist.template', 'rb'))"
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.release-watcher.plist.template', 'rb'))"

grep -F 'listen 8443 ssl;' deploy/nginx/default.conf.template >/dev/null
grep -F 'listen 8444 ssl;' deploy/nginx/default.conf.template >/dev/null
grep -F 'workflow_dispatch:' .github/workflows/release.yml >/dev/null
grep -Eq 'actions/attest@[0-9a-f]{40}[[:space:]]+# v4\.' .github/workflows/release.yml
grep -F 'gh release edit "${tag}" --draft=false --latest' .github/workflows/release.yml >/dev/null
grep -F 'release.immutable !== true' scripts/deploy/watch-release.sh >/dev/null
grep -F 'release.author?.login !== "github-actions[bot]"' scripts/deploy/watch-release.sh >/dev/null
grep -F 'PATH=/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin' deploy/runtime.env.example >/dev/null
grep -F -- '--deny-self-hosted-runners' scripts/deploy/release.sh >/dev/null
grep -F '/releases/latest' scripts/deploy/watch-release.sh >/dev/null
if grep -Eq '^[[:space:]]+push:' .github/workflows/release.yml; then
  echo "manual release workflow must not run on push" >&2
  exit 1
fi
if grep -Eq 'runs-on:.*self-hosted' .github/workflows/release.yml; then
  echo "public repository release workflow must not target a production self-hosted runner" >&2
  exit 1
fi

echo "deployment configuration gate passed"
