#!/bin/sh
set -eu

test_user="${BX_SSH_TEST_USERNAME:-bxssh}"
test_password="${BX_SSH_TEST_PASSWORD:?BX_SSH_TEST_PASSWORD is required}"
authorized_key="/test/authorized_keys"

if [ ! -s "${authorized_key}" ]; then
  echo "authorized key is missing" >&2
  exit 1
fi

mkdir -p /run/sshd
rm -f /etc/ssh/ssh_host_*
ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key

if ! id "${test_user}" >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash "${test_user}"
fi
printf '%s:%s\n' "${test_user}" "${test_password}" | chpasswd

test_home="$(getent passwd "${test_user}" | cut -d: -f6)"
install -d -m 0700 -o "${test_user}" -g "${test_user}" "${test_home}/.ssh"
install -m 0600 -o "${test_user}" -g "${test_user}" \
  "${authorized_key}" "${test_home}/.ssh/authorized_keys"

cat >/etc/ssh/sshd_config <<EOF
Port 22
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
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
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF

/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e
