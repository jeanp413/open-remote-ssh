import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import * as path from 'path';
import { exists } from '../common/files';
import { isMacintosh } from '../common/platform';

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

const MAX_SOCKET_PATH_LENGTH = isMacintosh ? 103 : 107;

export function getNativeSshSocketPath(label: string): string {
    const randomStr = crypto.randomBytes(15).toString('hex');
    if (process.platform === 'win32') {
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
