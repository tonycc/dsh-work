#!/usr/bin/env bash
# Issue one server certificate for all HTTPS ports on the Mac mini. Run on the
# operator workstation that holds the offline root CA.

set -euo pipefail

ca_dir=''
output_dir=''
server_ip=''
cert_days=365
force=0

usage() {
  printf '%s\n' \
    'Issue a server certificate with one private IPv4 SAN.' \
    '' \
    'Usage: bash scripts/deploy/issue-intranet-ip-certificate.sh --ca-dir ABSOLUTE_PATH --ip PRIVATE_IPV4 --output-dir ABSOLUTE_PATH [--days DAYS] [--force]'
}

fail() { printf 'issue-intranet-ip-certificate: %s\n' "$1" >&2; exit 1; }

is_private_ipv4() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] || return 1
  awk -F. '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
      }
      if ($1 == 10) exit 0
      if ($1 == 172 && $2 >= 16 && $2 <= 31) exit 0
      if ($1 == 192 && $2 == 168) exit 0
      exit 1
    }
  ' <<<"$1"
}

while (($# > 0)); do
  case "$1" in
    --ca-dir) ca_dir=${2:?}; shift 2 ;;
    --ip) server_ip=${2:?}; shift 2 ;;
    --output-dir) output_dir=${2:?}; shift 2 ;;
    --days) cert_days=${2:?}; shift 2 ;;
    --force) force=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ -n "${ca_dir}" && -n "${output_dir}" ]] || fail '--ca-dir and --output-dir are required'
[[ "${ca_dir}" == /* && "${output_dir}" == /* && "${ca_dir}" != / && "${output_dir}" != / ]] \
  || fail '--ca-dir and --output-dir must be absolute non-root paths'
is_private_ipv4 "${server_ip}" || fail '--ip must be an RFC1918 private IPv4 address'
[[ "${cert_days}" =~ ^[1-9][0-9]*$ ]] || fail '--days must be a positive integer'
((cert_days >= 1 && cert_days <= 825)) || fail '--days must be between 1 and 825'
command -v openssl >/dev/null 2>&1 || fail 'openssl is required'

root_key="${ca_dir}/root-ca.key"
root_cert="${ca_dir}/root-ca.crt"
[[ -f "${root_key}" && -f "${root_cert}" ]] || fail "root-ca.key/root-ca.crt not found in ${ca_dir}"
mkdir -p "${output_dir}"
chmod 700 "${output_dir}"
for target in server.key server.crt root-ca.crt; do
  if [[ -e "${output_dir}/${target}" && "${force}" -ne 1 ]]; then
    fail "${output_dir}/${target} already exists (use --force to replace server material)"
  fi
done

umask 077
stage_dir="$(mktemp -d "${output_dir}/.issue.XXXXXX")"
cleanup() { rm -rf "${stage_dir}"; }
trap cleanup EXIT
cat >"${stage_dir}/server-extensions.cnf" <<EOF
[server_certificate]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = @subject_alt_names

[subject_alt_names]
IP.1 = ${server_ip}
EOF

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${stage_dir}/server.key"
openssl req -new -sha256 -key "${stage_dir}/server.key" \
  -subj "/O=Company Intranet/CN=${server_ip}" -out "${stage_dir}/server.csr"
openssl x509 -req -sha256 -days "${cert_days}" \
  -in "${stage_dir}/server.csr" \
  -CA "${root_cert}" \
  -CAkey "${root_key}" \
  -CAcreateserial \
  -extfile "${stage_dir}/server-extensions.cnf" \
  -extensions server_certificate \
  -out "${stage_dir}/server.crt"

openssl verify -CAfile "${root_cert}" "${stage_dir}/server.crt" >/dev/null
if openssl x509 -help 2>&1 | grep -q -- '-checkip'; then
  openssl x509 -in "${stage_dir}/server.crt" -noout -checkip "${server_ip}" >/dev/null \
    || fail "issued certificate does not contain IP SAN ${server_ip}"
else
  openssl x509 -in "${stage_dir}/server.crt" -noout -text \
    | grep -F "IP Address:${server_ip}" >/dev/null \
    || fail "issued certificate does not contain IP SAN ${server_ip}"
fi

install -m 0600 "${stage_dir}/server.key" "${output_dir}/server.key"
install -m 0644 "${stage_dir}/server.crt" "${output_dir}/server.crt"
install -m 0644 "${root_cert}" "${output_dir}/root-ca.crt"
printf 'Issued intranet certificate for %s. Copy only server.key, server.crt, and root-ca.crt to the Mac mini.\n' "${server_ip}"
printf 'Keep %s offline.\n' "${root_key}"
