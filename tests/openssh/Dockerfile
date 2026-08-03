ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/bx-ssh-test-sshd
RUN chmod 0755 /usr/local/bin/bx-ssh-test-sshd

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/bx-ssh-test-sshd"]
