import { Socket } from 'node:net';
import { installDistro, isWslUsable, wslBash } from './run-wsl';

export type WslSshServerOptions = {
  distro: string;
  username: string;
  password: string;
  port: number;
};

/**
 * Provision a real OpenSSH server inside a WSL distribution.
 *
 * The Linux-remote counterpart to the `windows-*` fixtures. A Windows Docker
 * daemon serves Windows containers only, so it can host those images but not
 * `linuxserver/openssh-server`; WSL2 gives a real Linux kernel with a real
 * `sshd` instead. So the extension under test runs as a genuine Windows client
 * against a genuine Linux remote.
 *
 * Returns the address the server is reachable at FROM WINDOWS, which is not
 * knowable up front: with WSL2's localhost forwarding it's `127.0.0.1`, and
 * without it the distribution's own address behind WSL's NAT. Both are probed.
 *
 * systemd is not enabled in WSL by default, so `sshd` is started directly
 * rather than through its unit file. It daemonizes, which also keeps the
 * distribution's VM alive between `wsl.exe` invocations.
 */
export async function startWslSshServer({ distro, username, password, port }: WslSshServerOptions): Promise<string> {
  installDistro(distro);

  // Listening on every interface is what makes the NAT fallback below possible.
  // The distribution sits behind WSL's NAT, so this is not reachable off-host.
  const script = `
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if [ ! -x /usr/sbin/sshd ]; then
  apt-get update -qq
  # Mirrors dockerfiles/ubuntu-bash so the remote matches what the Docker
  # fixtures provide: the server install script fetches a tarball over HTTPS.
  apt-get install -y -qq --no-install-recommends openssh-server ca-certificates curl sudo
fi

id -u ${username} > /dev/null 2>&1 || useradd --create-home --shell /bin/bash ${username}
echo '${username}:${password}' | chpasswd

mkdir -p /run/sshd

cat > /etc/ssh/sshd_config <<'SSHD_CONFIG'
Port ${port}
PasswordAuthentication yes
PermitRootLogin no
UsePAM no
PrintMotd no
Subsystem sftp /usr/lib/openssh/sftp-server
SSHD_CONFIG

ssh-keygen -A

# Replace any previous run so re-invocation is idempotent.
pkill -x sshd 2> /dev/null || true
/usr/sbin/sshd

# bash's /dev/tcp is always present, unlike ss(1) or netstat(1).
for _ in $(seq 1 30); do
  if (echo > /dev/tcp/127.0.0.1/${port}) 2> /dev/null; then
    echo "listening"
    exit 0
  fi
  sleep 1
done

echo "sshd did not start listening on ${port}" >&2
exit 1
`;

  wslBash(distro, script);

  const candidates = ['127.0.0.1', ...wslAddresses(distro)];

  for (const host of candidates) {
    if (await canConnect(host, port)) {
      return host;
    }
  }

  throw new Error(`sshd is listening inside ${distro} but unreachable from Windows (tried ${candidates.join(', ')})`);
}

export function stopWslSshServer(distro: string): void {
  wslBash(distro, 'pkill -x sshd 2> /dev/null || true\n', { allowFailure: true });
}

function wslAddresses(distro: string): string[] {
  const result = wslBash(distro, 'hostname -I\n', { allowFailure: true });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout.split(/\s+/).filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
}

function canConnect(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();

    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export { isWslUsable };
