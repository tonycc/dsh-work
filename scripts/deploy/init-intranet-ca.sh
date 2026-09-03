#!/usr/bin/env bash
# Create the shared offline root CA on an operator workstation. Never run this
# on the production Mac mini and never copy root-ca.key to either deployment.

set -euo pipefail

ca_dir=''
ca_name='Company Intranet Root CA'
ca_days=3650

usage() {
  printf '%s\n' \
    'Create the shared offline root CA for IP-only intranet services.' \
    '' \
    'Usage: bash scripts/deploy/init-intranet-ca.sh --ca-dir ABSOLUTE_PATH [--name NAME] [--days DAYS]'
}

fail() { printf 'init-intranet-ca: %s\n' "$1" >&2; exit 1; }

while (($# > 0)); do
  case "$1" in
    --ca-dir) ca_dir=${2:?}; shift 2 ;;
    --name) ca_name=${2:?}; shift 2 ;;
    --days) ca_days=${2:?}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ -n "${ca_dir}" ]] || fail '--ca-dir is required'
[[ "${ca_dir}" == /* && "${ca_dir}" != / ]] || fail '--ca-dir must be an absolute non-root path'
[[ "${ca_days}" =~ ^[1-9][0-9]*$ ]] || fail '--days must be a positive integer'
((ca_days >= 365)) || fail '--days must be at least 365'
command -v openssl >/dev/null 2>&1 || fail 'openssl is required'

mkdir -p "${ca_dir}"
chmod 700 "${ca_dir}"
root_key="${ca_dir}/root-ca.key"
root_cert="${ca_dir}/root-ca.crt"
[[ ! -e "${root_key}" && ! -e "${root_cert}" ]] \
  || fail "root CA already exists in ${ca_dir}; refusing to overwrite it"

umask 077
config="$(mktemp "${ca_dir}/.root-ca-openssl.XXXXXX")"
cleanup() { rm -f "${config}"; }
trap cleanup EXIT
cat >"${config}" <<EOF
[req]
prompt = no
distinguished_name = distinguished_name
x509_extensions = root_ca

[distinguished_name]
O = Company Intranet
CN = ${ca_name}

[root_ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${root_key}"
openssl req -x509 -new -sha256 -days "${ca_days}" \
  -key "${root_key}" -config "${config}" -out "${root_cert}"
chmod 600 "${root_key}"
chmod 644 "${root_cert}"
openssl verify -CAfile "${root_cert}" "${root_cert}" >/dev/null

printf 'Created offline root CA:\n'
printf '  private key: %s (keep offline; never copy to the server)\n' "${root_key}"
printf '  public cert: %s\n' "${root_cert}"
openssl x509 -in "${root_cert}" -noout -fingerprint -sha256
