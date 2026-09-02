#!/usr/bin/env bash
set -euo pipefail

private_ip=${1:?Usage: generate-ip-certificate.sh PRIVATE_IP DEPLOY_ROOT}
deploy_root=${2:?Usage: generate-ip-certificate.sh PRIVATE_IP DEPLOY_ROOT}
umask 077
certificate_directory="${deploy_root}/certs"

python3 -c 'import ipaddress, sys; ipaddress.ip_address(sys.argv[1])' "${private_ip}" \
  || { echo "invalid private IP: ${private_ip}" >&2; exit 1; }

for target in internal-ca.key internal-ca.crt server.key server.crt; do
  if [[ -e "${certificate_directory}/${target}" ]]; then
    echo "refusing to overwrite existing certificate material: ${certificate_directory}/${target}" >&2
    exit 1
  fi
done

mkdir -p "${certificate_directory}"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-cert.XXXXXX")
cleanup() {
  rm -rf "${temporary_directory}"
}
trap cleanup EXIT

openssl genrsa -out "${certificate_directory}/internal-ca.key" 4096
openssl req -x509 -new -sha256 -days 1825 \
  -key "${certificate_directory}/internal-ca.key" \
  -out "${certificate_directory}/internal-ca.crt" \
  -subj "/CN=dsh-work Internal Pilot CA"

openssl genrsa -out "${certificate_directory}/server.key" 3072
openssl req -new \
  -key "${certificate_directory}/server.key" \
  -out "${temporary_directory}/server.csr" \
  -subj "/CN=${private_ip}"

printf '%s\n' \
  'basicConstraints=CA:FALSE' \
  'keyUsage=digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  "subjectAltName=IP:${private_ip}" > "${temporary_directory}/server.ext"

openssl x509 -req -sha256 -days 825 \
  -in "${temporary_directory}/server.csr" \
  -CA "${certificate_directory}/internal-ca.crt" \
  -CAkey "${certificate_directory}/internal-ca.key" \
  -CAcreateserial \
  -out "${certificate_directory}/server.crt" \
  -extfile "${temporary_directory}/server.ext"

chmod 600 "${certificate_directory}/internal-ca.key" "${certificate_directory}/server.key"
chmod 644 "${certificate_directory}/internal-ca.crt" "${certificate_directory}/server.crt"
echo "pilot certificate created in ${certificate_directory}"
echo "install internal-ca.crt as a trusted root on every client device; use the enterprise CA when available"
