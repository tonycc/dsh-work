#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: watch-release.sh DEPLOY_ROOT}
runtime_env="${deploy_root}/runtime.env"
automation_root="${deploy_root}/automation"
umask 077

release_version_script="${automation_root}/release-version.sh"
if [[ ! -r "${release_version_script}" ]]; then
  release_version_script="${deploy_root}/current/scripts/deploy/release-version.sh"
fi
if [[ ! -r "${release_version_script}" ]]; then
  release_version_script="${deploy_root}/scripts/deploy/release-version.sh"
fi
[[ -r "${release_version_script}" ]] \
  || { echo "release watcher: release version helper is unavailable" >&2; exit 1; }
# shellcheck disable=SC1090
source "${release_version_script}"

[[ -r "${runtime_env}" ]] || { echo "release watcher: missing ${runtime_env}" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

[[ "${DSH_WORK_AUTO_DEPLOY_ENABLED:-false}" == true ]] || exit 0

repository=${DSH_WORK_GITHUB_REPOSITORY:?Set DSH_WORK_GITHUB_REPOSITORY in runtime.env}
[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || { echo "release watcher: invalid GitHub repository: ${repository}" >&2; exit 1; }
node_bin=${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}
[[ -x "${node_bin}" ]] || { echo "release watcher: Node.js is not executable: ${node_bin}" >&2; exit 1; }

state_root="${automation_root}/state"
mkdir -p "${state_root}" "${deploy_root}/logs"

watch_lock="${automation_root}/.watch.lock"
if ! mkdir "${watch_lock}" 2>/dev/null; then
  locked_pid=''
  [[ -r "${watch_lock}/pid" ]] && locked_pid=$(<"${watch_lock}/pid")
  if [[ "${locked_pid}" =~ ^[0-9]+$ ]] \
    && kill -0 "${locked_pid}" 2>/dev/null; then
    exit 0
  fi
  rm -f "${watch_lock}/pid"
  if ! rmdir "${watch_lock}" 2>/dev/null || ! mkdir "${watch_lock}" 2>/dev/null; then
    echo "release watcher: cannot recover stale lock ${watch_lock}" >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "${watch_lock}/pid"

metadata_file=$(mktemp "${automation_root}/release-metadata.XXXXXX")
cleanup() {
  rm -f "${metadata_file}"
  rm -f "${watch_lock}/pid"
  rmdir "${watch_lock}" 2>/dev/null || true
}
trap cleanup EXIT

http_status=$(curl \
  --location \
  --silent \
  --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 2 \
  --retry-delay 5 \
  --proto '=https' \
  --tlsv1.2 \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  --header 'User-Agent: dsh-work-release-watcher' \
  "https://api.github.com/repos/${repository}/releases/latest" \
  --output "${metadata_file}" \
  --write-out '%{http_code}')

case "${http_status}" in
  200) ;;
  404) exit 0 ;;
  *)
    echo "release watcher: GitHub latest Release API returned HTTP ${http_status}" >&2
    exit 1
    ;;
esac

release_record=$("${node_bin}" -e '
  const { readFileSync } = require("node:fs")
  const release = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const tag = release.tag_name
  const commit = release.target_commitish
  if (release.draft || release.prerelease) throw new Error("latest release is not a stable published release")
  if (release.immutable !== true) throw new Error("latest release is not immutable")
  if (release.author?.login !== "github-actions[bot]") throw new Error("latest release was not published by GitHub Actions")
  const isDateRelease = /^v[0-9]{4}\.(?:0[1-9]|1[0-2])\.(?:0[1-9]|[12][0-9]|3[01])-[0-9]{2}$/.test(tag ?? "")
  const isLegacyRelease = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(tag ?? "")
  if (!isDateRelease && !isLegacyRelease) {
    throw new Error("latest release tag is not a supported stable version")
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("release target is not an immutable commit SHA")
  const expected = new Set([`dsh-work-${tag}.tar.gz`, `dsh-work-${tag}.tar.gz.sha256`])
  for (const name of expected) {
    const assets = (release.assets ?? []).filter(asset => asset.name === name && asset.state === "uploaded")
    if (assets.length !== 1) throw new Error(`release asset is missing or ambiguous: ${name}`)
  }
  process.stdout.write(`${tag}\t${commit}`)
' "${metadata_file}")

IFS=$'\t' read -r candidate_tag candidate_commit <<< "${release_record}"
active_tag=''
if [[ -r "${deploy_root}/active-release" ]]; then
  active_tag=$(<"${deploy_root}/active-release")
fi
[[ "${candidate_tag}" == "${active_tag}" ]] && exit 0

blocked_file="${state_root}/blocked-release"
if [[ -r "${blocked_file}" && "$(<"${blocked_file}")" == "${candidate_tag}" ]]; then
  exit 0
fi
attempted_file="${state_root}/attempted-release"
if [[ -r "${attempted_file}" && "$(<"${attempted_file}")" == "${candidate_tag}" ]]; then
  mv "${attempted_file}" "${blocked_file}"
  echo "release watcher: ${candidate_tag} was interrupted after deployment started and is now blocked" >&2
  exit 1
fi

if [[ -n "${active_tag}" ]]; then
  if [[ "${active_tag}" != v* ]] || ! is_supported_release_version "${active_tag#v}"; then
    echo "release watcher: active-release contains an invalid tag: ${active_tag}" >&2
    exit 1
  fi
  is_newer=$("${node_bin}" -e '
    const parse = value => {
      const dateMatch = /^v(\d{4})\.(\d{2})\.(\d{2})-(\d{2})$/.exec(value)
      if (dateMatch) return { kind: "date", parts: dateMatch.slice(1).map(Number) }
      const legacyMatch = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value)
      if (legacyMatch) return { kind: "legacy", parts: legacyMatch.slice(1).map(Number) }
      throw new Error(`unsupported release tag: ${value}`)
    }
    const candidate = parse(process.argv[1])
    const active = parse(process.argv[2])
    let comparison = 0
    if (candidate.kind !== active.kind) {
      comparison = candidate.kind === "date" ? 1 : -1
    } else {
      for (let index = 0; index < candidate.parts.length; index += 1) {
        if (candidate.parts[index] === active.parts[index]) continue
        comparison = candidate.parts[index] > active.parts[index] ? 1 : -1
        break
      }
    }
    process.stdout.write(String(comparison === 1))
  ' "${candidate_tag}" "${active_tag}")
  if [[ "${is_newer}" != true ]]; then
    printf '%s\n' "${candidate_tag}" > "${blocked_file}.new"
    mv "${blocked_file}.new" "${blocked_file}"
    echo "release watcher: refusing automatic downgrade from ${active_tag} to ${candidate_tag}" >&2
    exit 0
  fi
fi

deploy_script="${deploy_root}/current/scripts/deploy/release.sh"
if [[ ! -x "${deploy_script}" ]]; then
  deploy_script="${deploy_root}/scripts/deploy/release.sh"
fi
[[ -x "${deploy_script}" ]] \
  || { echo "release watcher: deployment script is unavailable" >&2; exit 1; }

version=${candidate_tag#v}
echo "release watcher: deploying ${candidate_tag} (${candidate_commit})"
rm -f "${attempted_file}"
if ! "${deploy_script}" "${version}" "${deploy_root}"; then
  if [[ -r "${attempted_file}" && "$(<"${attempted_file}")" == "${candidate_tag}" ]]; then
    mv "${attempted_file}" "${blocked_file}"
    echo "release watcher: ${candidate_tag} failed after deployment started and is blocked until an operator clears ${blocked_file}" >&2
  else
    echo "release watcher: ${candidate_tag} failed before deployment started and will be checked again" >&2
  fi
  exit 1
fi

rm -f "${blocked_file}" "${attempted_file}"
new_watcher="${deploy_root}/current/scripts/deploy/watch-release.sh"
installed_watcher="${automation_root}/watch-release.sh"
if [[ -r "${new_watcher}" ]] && ! cmp -s "${new_watcher}" "${installed_watcher}"; then
  cp "${new_watcher}" "${installed_watcher}.new"
  chmod 700 "${installed_watcher}.new"
  mv "${installed_watcher}.new" "${installed_watcher}"
fi
new_release_version="${deploy_root}/current/scripts/deploy/release-version.sh"
installed_release_version="${automation_root}/release-version.sh"
if [[ -r "${new_release_version}" ]] && ! cmp -s "${new_release_version}" "${installed_release_version}"; then
  cp "${new_release_version}" "${installed_release_version}.new"
  chmod 700 "${installed_release_version}.new"
  mv "${installed_release_version}.new" "${installed_release_version}"
fi
echo "release watcher: ${candidate_tag} deployed successfully"
