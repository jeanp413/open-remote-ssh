import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getNativeSshSocketPath } from '../src/native/nativeSshConnection';

it.skipIf(process.platform === 'win32').each(['TMPDIR', 'XDG_RUNTIME_DIR'])('bounds socket paths from %s in bytes', async variable => {
    const root = await mkdtemp('/tmp/ors-');
    // The ASCII path matches a macOS temp directory; the multibyte path needs a fallback.
    const dir = join(root, (variable === 'TMPDIR' ? 'x' : 'é').repeat(32));
    await mkdir(dir);
    vi.stubEnv('TMPDIR', dir);
    vi.stubEnv('XDG_RUNTIME_DIR', variable === 'XDG_RUNTIME_DIR' ? dir : undefined);
    try {
        for (const label of ['askpass', 'localSshServer']) {
            const socket = getNativeSshSocketPath(label);
            expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
            expect(dirname(socket)).toBe(variable === 'TMPDIR' ? dir : '/tmp');
            const server = createServer();
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(socket, resolve);
                });
            } finally {
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
        }
    } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
});
