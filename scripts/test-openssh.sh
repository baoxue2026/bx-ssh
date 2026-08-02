#!/usr/bin/env bash
set -euo pipefail

test_root="$(mktemp -d)"
test_user="bxssh_ci_${RANDOM}"
test_password="bx-ssh-ci-password"
sshd_pid=""

cleanup() {
  if [[ -n "${sshd_pid}" ]]; then
    sudo kill "${sshd_pid}" 2>/dev/null || true
    wait "${sshd_pid}" 2>/dev/null || true
  fi
  if id "${test_user}" >/dev/null 2>&1; then
    sudo userdel --remove "${test_user}" >/dev/null 2>&1 || true
  fi
  rm -rf "${test_root}"
}
trap cleanup EXIT

sudo mkdir -p /run/sshd
sudo useradd --create-home --user-group --shell /bin/bash "${test_user}"
printf '%s:%s\n' "${test_user}" "${test_password}" | sudo chpasswd

client_key="${test_root}/client_ed25519"
host_key="${test_root}/ssh_host_ed25519_key"
sshd_config="${test_root}/sshd_config"
sshd_log="${test_root}/sshd.log"
test_home="$(getent passwd "${test_user}" | cut -d: -f6)"

ssh-keygen -q -t ed25519 -N "" -f "${client_key}"
ssh-keygen -q -t ed25519 -N "" -f "${host_key}"

sudo install -d -m 700 -o "${test_user}" -g "${test_user}" "${test_home}/.ssh"
sudo install -m 600 -o "${test_user}" -g "${test_user}" \
  "${client_key}.pub" "${test_home}/.ssh/authorized_keys"

cat >"${sshd_config}" <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey ${host_key}
PidFile ${test_root}/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PasswordAuthentication yes
PubkeyAuthentication yes
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM no
PermitRootLogin no
PermitEmptyPasswords no
StrictModes yes
AllowUsers ${test_user}
LogLevel VERBOSE
EOF

sudo /usr/sbin/sshd -t -f "${sshd_config}"
sudo /usr/sbin/sshd -D -e -f "${sshd_config}" 2>"${sshd_log}" &
sshd_pid="$!"

sshd_ready=false
for _ in {1..30}; do
  if ssh-keyscan -p 2222 127.0.0.1 >/dev/null 2>&1; then
    sshd_ready=true
    break
  fi
  sleep 1
done

if [[ "${sshd_ready}" != true ]] || ! kill -0 "${sshd_pid}" 2>/dev/null; then
  cat "${sshd_log}"
  exit 1
fi

BX_SSH_TEST_HOST=127.0.0.1 \
BX_SSH_TEST_PORT=2222 \
BX_SSH_TEST_USERNAME="${test_user}" \
BX_SSH_TEST_PASSWORD="${test_password}" \
BX_SSH_TEST_PRIVATE_KEY="${client_key}" \
  cargo test -p bx-ssh-core --test openssh -- --ignored --nocapture
