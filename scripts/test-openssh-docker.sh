#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 <base-image> <matrix-id>" >&2
  exit 2
fi

base_image="$1"
matrix_id="$2"
test_root="$(mktemp -d)"
test_user="bxssh"
test_password="bx-ssh-ci-password"
run_id="${GITHUB_RUN_ID:-local}-$$"
image_name="bx-ssh-openssh-${matrix_id}:${run_id}"
container_name="bx-ssh-openssh-${matrix_id}-${run_id}"
report_dir="artifacts/test-reports"
container_started=false
server_version="unavailable"

cleanup() {
  status="$?"
  set +e
  mkdir -p "${report_dir}"
  if [[ "${container_started}" == true ]]; then
    docker logs "${container_name}" >"${report_dir}/openssh-${matrix_id}.log" 2>&1
    docker rm --force "${container_name}" >/dev/null 2>&1
  fi
  result="PASS"
  if [[ "${status}" -ne 0 ]]; then
    result="FAIL"
  fi
  cat >"${report_dir}/openssh-${matrix_id}.md" <<EOF
# BX SSH OpenSSH integration test

- Matrix: ${matrix_id}
- Base image: ${base_image}
- Server: ${server_version}
- Result: ${result}
EOF
  rm -rf "${test_root}"
  exit "${status}"
}
trap cleanup EXIT

client_key="${test_root}/client_ed25519"
ssh-keygen -q -t ed25519 -N "" -f "${client_key}"

docker build \
  --build-arg "BASE_IMAGE=${base_image}" \
  --tag "${image_name}" \
  tests/openssh

docker run --detach --rm \
  --name "${container_name}" \
  --publish 127.0.0.1::22 \
  --env "BX_SSH_TEST_USERNAME=${test_user}" \
  --env "BX_SSH_TEST_PASSWORD=${test_password}" \
  --mount "type=bind,src=${client_key}.pub,dst=/test/authorized_keys,readonly" \
  "${image_name}" >/dev/null
container_started=true

host_port="$(docker inspect \
  --format '{{(index (index .NetworkSettings.Ports "22/tcp") 0).HostPort}}' \
  "${container_name}")"

sshd_ready=false
for _ in {1..30}; do
  if ssh-keyscan -p "${host_port}" 127.0.0.1 >/dev/null 2>&1; then
    sshd_ready=true
    break
  fi
  if ! docker inspect --format '{{.State.Running}}' "${container_name}" | grep -q true; then
    break
  fi
  sleep 1
done

if [[ "${sshd_ready}" != true ]]; then
  echo "OpenSSH container did not become ready" >&2
  exit 1
fi

server_version="$(docker exec "${container_name}" ssh -V 2>&1)"
mkdir -p "${report_dir}"

BX_SSH_TEST_HOST=127.0.0.1 \
BX_SSH_TEST_PORT="${host_port}" \
BX_SSH_TEST_USERNAME="${test_user}" \
BX_SSH_TEST_PASSWORD="${test_password}" \
BX_SSH_TEST_PRIVATE_KEY="${client_key}" \
  cargo nextest run \
    --profile ci \
    --run-ignored ignored-only \
    -p bx-ssh-core \
    --test openssh \
    --test sftp
