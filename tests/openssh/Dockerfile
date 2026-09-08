ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
RUN if command -v apt-get >/dev/null 2>&1; then \
        apt-get update \
        && apt-get install -y --no-install-recommends openssh-client openssh-server \
        && rm -rf /var/lib/apt/lists/*; \
    elif command -v dnf >/dev/null 2>&1; then \
        dnf install -y openssh-clients openssh-server shadow-utils \
        && dnf clean all; \
    else \
        echo "unsupported package manager" >&2; \
        exit 2; \
    fi

COPY entrypoint.sh /usr/local/bin/bx-ssh-test-sshd
RUN chmod 0755 /usr/local/bin/bx-ssh-test-sshd

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/bx-ssh-test-sshd"]
