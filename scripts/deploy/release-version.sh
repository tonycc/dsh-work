#!/usr/bin/env bash

# dsh-work Release versions use a zero-padded date and a two-digit build number.
# Keep legacy SemVer support for already-published releases so an existing
# v0.1.x deployment can be upgraded or rolled back safely.
release_version_pattern='^[0-9]{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])-[0-9]{2}$'
legacy_release_version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

is_release_version() {
  [[ "${1:-}" =~ ${release_version_pattern} ]]
}

is_legacy_release_version() {
  [[ "${1:-}" =~ ${legacy_release_version_pattern} ]]
}

is_supported_release_version() {
  is_release_version "${1:-}" || is_legacy_release_version "${1:-}"
}

require_release_version() {
  local version=${1:-}
  is_release_version "${version}" \
    || { echo "invalid stable release version: ${version}" >&2; return 1; }
}

require_supported_release_version() {
  local version=${1:-}
  is_supported_release_version "${version}" \
    || { echo "invalid stable release version: ${version}" >&2; return 1; }
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  version=${1:?Usage: release-version.sh VERSION}
  version=${version#v}
  require_release_version "${version}"
fi
