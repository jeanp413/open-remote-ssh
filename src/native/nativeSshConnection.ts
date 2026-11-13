import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import * as path from 'path';
import { exists } from '../common/files';
import { isMacintosh, Platform, platform } from '../common/platform';
import SSHDestination from '../ssh/sshDestination';
import { defaultSSHConfigPath, getSSHConfigPath } from '../ssh/sshConfig';
import { quote } from '../common/quote';

export async function resolveNativeSshExecutable(explicitPath?: string): Promise<string> {
    if (explicitPath && explicitPath.trim().length > 0) {
        if (await exists(explicitPath)) {
            return explicitPath;
        }
        throw new Error(`Native SSH executable was not found at: ${explicitPath}`);
    }

    const candidates = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, platform === Platform.Windows ? 'ssh.exe' : 'ssh'));

    for (const candidate of candidates) {
        try {
            await fs.access(candidate, fs.constants.X_OK);
            return path.basename(candidate);
        } catch {
            // keep trying other PATH entries
        }
    }

    throw new Error('Native SSH executable not found in PATH. Install OpenSSH or set the ssh path explicitly.');
}

export async function resolveNativeScpExecutable(sshExecutable?: string): Promise<string> {
    if (sshExecutable && sshExecutable.trim().length > 0 && path.isAbsolute(sshExecutable)) {
        const dir = path.dirname(sshExecutable);
        const base = path.basename(sshExecutable);
        const scpName = platform === Platform.Windows
            ? base.replace(/^ssh(\\.exe)?$/i, (_, ext) => `scp${ext ?? ''}`)
            : base.replace(/^ssh$/, 'scp');
        if (scpName !== base) {
            const sibling = path.join(dir, scpName);
            if (await exists(sibling)) {
                return sibling;
            }
        }
    }

    const candidates = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((d) => path.join(d, platform === Platform.Windows ? 'scp.exe' : 'scp'));

    for (const candidate of candidates) {
        try {
            await fs.access(candidate, fs.constants.X_OK);
            return path.basename(candidate);
        } catch {
            // keep trying other PATH entries
        }
    }

    throw new Error('Native SCP executable not found. Install OpenSSH or ensure scp is on PATH.');
}

const MAX_SOCKET_PATH_LENGTH = isMacintosh ? 103 : 107;

export function getNativeSshSocketPath(label: string): string {
    const randomStr = crypto.randomBytes(15).toString('hex');
    if (platform === Platform.Windows) {
        return `\\\\.\\pipe\\or-ssh-${label}-${randomStr}-sock`;
    }

    const baseDir = process.env.XDG_RUNTIME_DIR ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
    const prefix = 'or-ssh-';
    const suffix = '.sock';

    // Format: [baseDir]/[prefix][label]-[randomStr][suffix]
    const basicPathLength = baseDir.length + 1 + prefix.length + label.length + 1 + suffix.length;
    const availableRandomChars = MAX_SOCKET_PATH_LENGTH - basicPathLength;
    const sliceLength = Math.max(6, Math.min(randomStr.length, availableRandomChars));

    const truncatedRandomStr = randomStr.substring(0, sliceLength);

    const finalPath = path.join(baseDir, `${prefix}${label}-${truncatedRandomStr}${suffix}`);

    if (finalPath.length > MAX_SOCKET_PATH_LENGTH) {
        throw new Error(`The socket path '${finalPath}' length exceeds the limit of ${MAX_SOCKET_PATH_LENGTH}`);
    }

    return finalPath;
}

export function computeSshArgs(sshDestination: SSHDestination, extraArgs:string[] ): string[] {
    const sshArgs = [...extraArgs];

    const configFile = getSSHConfigPath();
    if (configFile !== defaultSSHConfigPath) {
        sshArgs.push('-F', configFile);
    }

    if (sshDestination.port) {
        sshArgs.push('-p', String(sshDestination.port));
    }
    if (sshDestination.user) {
        sshArgs.push('-l', sshDestination.user);
    }
    sshArgs.push(sshDestination.hostname);

    return sshArgs;
}

export function computeScpArgs(sshDestination: SSHDestination, extraArgs:string[], files: string[], remoteDir:string ): string[] {
    const scpArgs = [...extraArgs];

    const configFile = getSSHConfigPath();
    if (configFile !== defaultSSHConfigPath) {
        scpArgs.push('-F', quote(configFile, platform));
    }

    if (sshDestination.port) {
        scpArgs.unshift('-P', String(sshDestination.port));
    }

    scpArgs.push(...files.map(f=>quote(f, platform)));

    const target = sshDestination.user ? `${sshDestination.user}@${sshDestination.hostname}` : sshDestination.hostname;
    const remoteDest = `${target}:${quote(remoteDir,platform)}`;
    scpArgs.push(remoteDest);

    return scpArgs;
}
