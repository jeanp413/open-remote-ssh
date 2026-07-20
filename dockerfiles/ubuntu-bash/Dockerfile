FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    ca-certificates \
    sudo \
    curl \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 2222
VOLUME /config

COPY start-sshd.sh /usr/local/bin/start-sshd.sh
RUN chmod +x /usr/local/bin/start-sshd.sh

CMD ["/usr/local/bin/start-sshd.sh"]
