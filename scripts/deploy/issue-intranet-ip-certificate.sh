#!/usr/bin/env bash
# Backward-compatible entry point. The generic issuer accepts one or more
# repeated --ip and --dns arguments.

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd -P)
exec bash "${script_dir}/issue-intranet-certificate.sh" "$@"
