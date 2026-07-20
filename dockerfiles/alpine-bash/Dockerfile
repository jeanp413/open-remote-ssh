FROM alpine:3.24

RUN apk update && apk add --no-cache \
    openssh-server \
    sudo \
    curl \
    bash \
    shadow \
    libstdc++ \
    libgcc

EXPOSE 2222
VOLUME /config

COPY start-sshd.sh /usr/local/bin/start-sshd.sh
RUN chmod +x /usr/local/bin/start-sshd.sh

CMD ["/usr/local/bin/start-sshd.sh"]
