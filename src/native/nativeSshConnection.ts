import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import * as path from 'path';
import { exists } from '../common/files';

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
        .map((directory) => path.join(directory, process.platform === 'win32' ? 'ssh.exe' : 'ssh'));

    for (const candidate of candidates) {
        try {
            await fs.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // keep trying other PATH entries
        }
    }

    throw new Error('Native SSH executable not found in PATH. Install OpenSSH or set the ssh path explicitly.');
}

export function getNativeSshSocketPath(label: string): string {
    const randomStr = crypto.randomBytes(15).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\open-remote-ssh-${label}-${randomStr}`;
    }
    return process.env.XDG_RUNTIME_DIR
           ? path.join(process.env.XDG_RUNTIME_DIR, `open-remote-ssh-${label}-${randomStr}.sock`)
           : path.join(os.tmpdir(), `open-remote-ssh-${label}-${randomStr}.sock`);
}
