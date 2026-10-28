import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

class FakeChildProcess extends EventEmitter {
    pid = 12345;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    kill = vi.fn((signal?: NodeJS.Signals) => {
        this.killed = true;
        this.signalCode = signal ?? 'SIGTERM';
        return true;
    });
}

let fakeChild: FakeChildProcess;

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
        ...actual,
        spawn: vi.fn(() => {
            fakeChild = new FakeChildProcess();
            return fakeChild;
        }),
    };
});

import { NativeSshHelperServer } from '../src/native/nativeSshServer';
import { NativeSshServerConfig } from '../src/native/nativeSshManager';

async function makeServer(overrides: Partial<NativeSshServerConfig> = {}): Promise<{
    server: NativeSshHelperServer;
    config: NativeSshServerConfig;
    dir: string;
}> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-helper-test-'));
    const config: NativeSshServerConfig = {
        sshExecutable: '/usr/bin/ssh',
        sshArgs: ['-T', 'user@host'],
        socketPath: path.join(dir, 'helper.sock'),
        registryFilePath: path.join(dir, 'registry.json'),
        ...overrides,
    };
    await fs.writeFile(
        config.registryFilePath,
        JSON.stringify({ schemaVersion: 1, socketPath: config.socketPath, pid: process.pid }),
    );
    const server = new NativeSshHelperServer(config);
    await server.start();
    return { server, config, dir };
}

function request(
    socketPath: string,
    method: 'GET' | 'POST',
    route: string,
): Promise<{ statusCode: number | undefined; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: route, method }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { body += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('NativeSshHelperServer', () => {
    let server: NativeSshHelperServer | undefined;
    let dir: string | undefined;

    afterEach(async () => {
        server?.close();
        server = undefined;
        if (dir) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
        dir = undefined;
        vi.useRealTimers();
    });

    it('keepalive endpoint accepts only POST', async () => {
        const ctx = await makeServer();
        server = ctx.server;
        dir = ctx.dir;

        const post = await request(ctx.config.socketPath, 'POST', '/keepalive');
        expect(post.statusCode).toBe(200);

        const get = await request(ctx.config.socketPath, 'GET', '/keepalive');
        expect(get.statusCode).toBe(404);
    });

    // Regression: `removeNativeSshHelperRegistry` used unlinkSync without
    // try/catch, so a race with the manager's cleanup threw ENOENT during
    // shutdown.
    it('close() does not throw when the registry file is already gone', async () => {
        const ctx = await makeServer();
        server = ctx.server;
        dir = ctx.dir;
        await fs.unlink(ctx.config.registryFilePath);
        expect(() => ctx.server.close()).not.toThrow();
    });

    // The helper self-terminates when keepalives stop. This is the entire
    // mechanism behind multi-window reuse — if it breaks, every window
    // accumulates orphan helpers.
    it('closes after HELPER_IDLE_TIMEOUT_MS without keepalives', async () => {
        vi.useFakeTimers();
        const ctx = await makeServer();
        server = ctx.server;
        dir = ctx.dir;

        await vi.advanceTimersByTimeAsync(60_000 + 100);
        await Promise.resolve();

        await expect(
            request(ctx.config.socketPath, 'GET', '/health'),
        ).rejects.toThrow();
    });

    // The other half of the reuse contract: a keepalive from any window
    // resets the timer, so the helper stays up while at least one window
    // is alive.
    it('keepalive resets the idle timer', async () => {
        vi.useFakeTimers();
        const ctx = await makeServer();
        server = ctx.server;
        dir = ctx.dir;

        await vi.advanceTimersByTimeAsync(50_000);
        await request(ctx.config.socketPath, 'POST', '/keepalive');

        // Past the original 60s deadline — the keepalive should have
        // pushed it out, so the server is still up.
        await vi.advanceTimersByTimeAsync(30_000);
        const res = await request(ctx.config.socketPath, 'GET', '/health');
        expect(res.statusCode).toBe(200);

        // Drain the remaining timer so afterEach's close() isn't racing it.
        await vi.advanceTimersByTimeAsync(60_000);
    });
});
