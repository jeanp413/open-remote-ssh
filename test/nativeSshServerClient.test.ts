import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NativeSshServerClient, NativeSshKeepalive } from '../src/native/nativeSshServerClient';
import type { ILogger } from '../src/common/logger';

interface TestServer {
    socketPath: string;
    handlers: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;
    close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-client-test-'));
    const socketPath = path.join(dir, 'test.sock');
    const handlers = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();

    const server = http.createServer((req, res) => {
        const handler = handlers.get(`${req.method} ${req.url}`);
        if (handler) { handler(req, res); return; }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
    });

    return {
        socketPath,
        handlers,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

function makeLogger(): ILogger & { error: ReturnType<typeof vi.fn> } {
    return {
        trace: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    } as unknown as ILogger & { error: ReturnType<typeof vi.fn> };
}

describe('NativeSshServerClient', () => {
    let server: TestServer;
    let client: NativeSshServerClient;

    beforeEach(async () => {
        server = await startTestServer();
        client = new NativeSshServerClient(server.socketPath);
    });

    afterEach(async () => {
        await server.close();
    });

    it('isHealthy returns true on 200', async () => {
        server.handlers.set('GET /health', (_req, res) => { res.statusCode = 200; res.end('{}'); });
        await expect(client.isHealthy()).resolves.toBe(true);
    });

    it('isHealthy returns false on 404', async () => {
        await expect(client.isHealthy()).resolves.toBe(false);
    });

    it('isHealthy returns false when the socket does not exist', async () => {
        const missing = new NativeSshServerClient(path.join(os.tmpdir(), `no-such-${Date.now()}.sock`));
        await expect(missing.isHealthy()).resolves.toBe(false);
    });

    it('keepalive sends POST to /keepalive', async () => {
        let observed: string | undefined;
        server.handlers.set('POST /keepalive', (req, res) => {
            observed = req.method;
            res.statusCode = 200;
            res.end();
        });
        await client.keepalive();
        expect(observed).toBe('POST');
    });

    // Regression: previously a 404 on /keepalive (e.g. wrong method) was
    // silently swallowed and the connection eventually dropped with no
    // log. The fix surfaces the failure to the caller.
    it('keepalive rejects on 404', async () => {
        // No POST /keepalive handler → 404.
        await expect(client.keepalive()).rejects.toThrow(/404/);
    });

    it('keepalive rejects when the socket does not exist', async () => {
        const missing = new NativeSshServerClient(path.join(os.tmpdir(), `no-such-${Date.now()}.sock`));
        await expect(missing.keepalive()).rejects.toThrow();
    });
});

describe('NativeSshKeepalive', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('pings immediately on start', async () => {
        const client = { keepalive: vi.fn().mockResolvedValue(undefined) };
        const ka = new NativeSshKeepalive(client as unknown as NativeSshServerClient, makeLogger(), 60_000);
        ka.start();
        await Promise.resolve();
        expect(client.keepalive).toHaveBeenCalledTimes(1);
        ka.dispose();
    });

    it('pings on each interval tick', async () => {
        vi.useFakeTimers();
        const client = { keepalive: vi.fn().mockResolvedValue(undefined) };
        const ka = new NativeSshKeepalive(client as unknown as NativeSshServerClient, makeLogger(), 1_000);
        ka.start();
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(client.keepalive).toHaveBeenCalledTimes(3);
        ka.dispose();
    });

    it('start() is idempotent', async () => {
        vi.useFakeTimers();
        const client = { keepalive: vi.fn().mockResolvedValue(undefined) };
        const ka = new NativeSshKeepalive(client as unknown as NativeSshServerClient, makeLogger(), 1_000);
        ka.start();
        ka.start();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(client.keepalive).toHaveBeenCalledTimes(2);
        ka.dispose();
    });

    it('dispose() stops further pings', async () => {
        vi.useFakeTimers();
        const client = { keepalive: vi.fn().mockResolvedValue(undefined) };
        const ka = new NativeSshKeepalive(client as unknown as NativeSshServerClient, makeLogger(), 1_000);
        ka.start();
        await vi.advanceTimersByTimeAsync(1_000);
        ka.dispose();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(client.keepalive).toHaveBeenCalledTimes(2);
    });

    it('running reflects the lifecycle', () => {
        const ka = new NativeSshKeepalive(
            { keepalive: vi.fn().mockResolvedValue(undefined) } as unknown as NativeSshServerClient,
            makeLogger(),
            1_000,
        );
        expect(ka.running).toBe(false);
        ka.start();
        expect(ka.running).toBe(true);
        ka.dispose();
        expect(ka.running).toBe(false);
    });

    // Regression: the silent-failure bug. With keepalive() fixed to
    // reject, ping()'s catch logs the error.
    it('logs when a ping fails', async () => {
        const client = { keepalive: vi.fn().mockRejectedValue(new Error('boom')) };
        const logger = makeLogger();
        const ka = new NativeSshKeepalive(client as unknown as NativeSshServerClient, logger, 1_000);
        ka.start();
        await Promise.resolve();
        await Promise.resolve();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
        ka.dispose();
    });
});
