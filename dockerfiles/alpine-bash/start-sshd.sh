#!/usr/bin/env bash
set -e

# create folders
mkdir -p /config/{.ssh,logs/openssh,sshd}
mkdir -p /run/sshd

USER_NAME=${USER_NAME:-linuxserver.io}
echo "User name is set to $USER_NAME"

if [[ -n "$USER_PASSWORD_FILE" ]] && [[ -f "$USER_PASSWORD_FILE" ]]; then
    USER_PASSWORD=$(cat "$USER_PASSWORD_FILE")
    echo "User password is retrieved from file."
fi

USER_PASSWORD=${USER_PASSWORD:-$(< /dev/urandom tr -dc _A-Z-a-z-0-9 | head -c"${1:-8}";echo;)}

useradd -m -s /bin/bash "${USER_NAME}"
echo "${USER_NAME}:${USER_PASSWORD}" | chpasswd
usermod -aG wheel "${USER_NAME}"

# Migration
if [[ -f /config/ssh_host_keys/sshd_config ]]; then
    mv /config/ssh_host_keys/sshd_config /config/sshd/sshd_config
    sed -i 's/Include \/etc\/ssh\/sshd_config.d\/\*.conf/#Include \/etc\/ssh\/sshd_config.d\/\*.conf/' /config/sshd/sshd_config
    echo "This file has been moved to /config/sshd/sshd_config" > /config/ssh_host_keys/sshd_config_README
    chmod 600 /config/ssh_host_keys/ssh_host_*_key
    chmod 644 /config/ssh_host_keys/ssh_host_*_key.pub
fi

if [[ ! -f /config/sshd/sshd_config ]]; then
    sed -i '/#PidFile/c\PidFile \/config\/sshd.pid' /etc/ssh/sshd_config
    sed -i 's/Include \/etc\/ssh\/sshd_config.d\/\*.conf/#Include \/etc\/ssh\/sshd_config.d\/\*.conf/' /etc/ssh/sshd_config
    cp -a /etc/ssh/sshd_config /config/sshd/sshd_config
fi

if [[ ! -d /config/ssh_host_keys ]]; then
    mkdir -p /config/ssh_host_keys
    ssh-keygen -A
    cp /etc/ssh/ssh_host_* /config/ssh_host_keys
fi

# Enable sshd_config.d if mounted
if [[ -d /config/sshd/sshd_config.d ]]; then
    sed -i 's/Include \/etc\/ssh\/sshd_config.d\/\*.conf/Include \/config\/sshd\/sshd_config.d\/\*.conf/' /config/sshd/sshd_config
    sed -i '/Include \/config\/sshd\/sshd_config.d/s/^#*//' /config/sshd/sshd_config
fi

# display SSH host public key(s)
echo "SSH host public key(s):"
cat /config/ssh_host_keys/ssh_host_*.pub

# custom port
if [[ -n "${LISTEN_PORT}" ]]; then
    sed -i "s/^#Port [[:digit:]]\+/Port ${LISTEN_PORT}"/ /config/sshd/sshd_config
    sed -i "s/^Port [[:digit:]]\+/Port ${LISTEN_PORT}"/ /config/sshd/sshd_config
    echo "sshd is listening on port ${LISTEN_PORT}"
else
    sed -i "s/^#Port [[:digit:]]\+/Port 2222"/ /config/sshd/sshd_config
    sed -i "s/^Port [[:digit:]]\+/Port 2222"/ /config/sshd/sshd_config
    echo "sshd is listening on port 2222"
fi

# password access
if [[ "$PASSWORD_ACCESS" == "true" ]]; then
    sed -i '/^#PasswordAuthentication/c\PasswordAuthentication yes' /config/sshd/sshd_config
    sed -i '/^PasswordAuthentication/c\PasswordAuthentication yes' /config/sshd/sshd_config
    chown root:"${USER_NAME}" /etc/shadow
    echo "User/password ssh access is enabled."
else
    sed -i '/^PasswordAuthentication/c\PasswordAuthentication no' /config/sshd/sshd_config
    chown root:root /etc/shadow
    echo "User/password ssh access is disabled."
fi

# set umask for sftp
UMASK=${UMASK:-022}
sed -i "s|/usr/lib/ssh/sftp-server$|/usr/lib/ssh/sftp-server -u ${UMASK}|g" /config/sshd/sshd_config

# set key auth in file
if [[ ! -f /config/.ssh/authorized_keys ]]; then
    touch /config/.ssh/authorized_keys
fi

if [[ -n "$PUBLIC_KEY" ]]; then
    if ! grep -q "${PUBLIC_KEY}" /config/.ssh/authorized_keys; then
        echo "$PUBLIC_KEY" >> /config/.ssh/authorized_keys
        echo "Public key from env variable added"
    fi
fi

if [[ -n "$PUBLIC_KEY_URL" ]]; then
    PUBLIC_KEY_DOWNLOADED=$(curl -s "$PUBLIC_KEY_URL")
    if ! grep -q "$PUBLIC_KEY_DOWNLOADED" /config/.ssh/authorized_keys; then
        echo "$PUBLIC_KEY_DOWNLOADED" >> /config/.ssh/authorized_keys
        echo "Public key downloaded from '$PUBLIC_KEY_URL' added"
    fi
fi

if [[ -n "$PUBLIC_KEY_FILE" ]] && [[ -f "$PUBLIC_KEY_FILE" ]]; then
    PUBLIC_KEY2=$(cat "$PUBLIC_KEY_FILE")
    if ! grep -q "$PUBLIC_KEY2" /config/.ssh/authorized_keys; then
        echo "$PUBLIC_KEY2" >> /config/.ssh/authorized_keys
        echo "Public key from file added"
    fi
fi

if [[ -d "$PUBLIC_KEY_DIR" ]]; then
    for F in "${PUBLIC_KEY_DIR}"/*; do
        PUBLIC_KEYN=$(cat "$F")
        if ! grep -q "$PUBLIC_KEYN" /config/.ssh/authorized_keys; then
            echo "$PUBLIC_KEYN" >> /config/.ssh/authorized_keys
            echo "Public key from file '$F' added"
        fi
    done
fi

# back up old log files processed by logrotate
if [[ -f /config/logs/openssh/openssh.log ]]; then
    mv /config/logs/openssh /config/logs/openssh.old.logs
    mkdir -p /config/logs/openssh
fi

# add log file info
if [[ ! -f /config/logs/loginfo.txt ]]; then
    echo "The current log file is named \"current\". The rotated log files are gzipped, named with a TAI64N timestamp and a \".s\" extension" > /config/logs/loginfo.txt
fi

# permissions
chown -R "${USER_NAME}":"${USER_NAME}" /config
chmod go-w /config
chmod 700 /config/.ssh
chmod 600 /config/.ssh/authorized_keys

chown -R root:"${USER_NAME}" /config/sshd
chmod 750 /config/sshd
chmod 640 /config/sshd/sshd_config

exec /usr/sbin/sshd -D -e -f /config/sshd/sshd_config
