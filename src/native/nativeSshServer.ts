import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as stream from 'stream';

import { type NativeSshServerConfig, NativeSshRegistryEntry } from './nativeSshManager';

const HELPER_IDLE_TIMEOUT_MS = 10_000;

function readNativeSshRegistry(registryFilePath: string) {
    const registryPath = registryFilePath;
    if (!fs.existsSync(registryPath)) {
        return undefined;
    }

    try {
        const raw = fs.readFileSync(registryPath, 'utf8');
        return JSON.parse(raw) as NativeSshRegistryEntry;
    } catch {
        return undefined;
    }
}

function removeNativeSshHelperRegistry(registryFilePath: string, pid: number) {
    const entry = readNativeSshRegistry(registryFilePath);
    if (!entry || entry.pid !== pid) {
        return;
    }
    try {
        fs.unlinkSync(registryFilePath);
    } catch {
        // noop
    }
}

export class NativeSshHelperServer {
    private readonly config: NativeSshServerConfig;
    private readonly server: http.Server;
    private sshProcess: NativeSshProcess | undefined;
    private idleTimer: NodeJS.Timeout | undefined;
    private closed = false;

    constructor(config: NativeSshServerConfig) {
        this.config = config;
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (req.method === 'GET' && req.url === '/health') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, pid: process.pid }));
            return;
        }

        if (req.method === 'POST' && req.url === '/keepalive') {
            this.resetIdleTimer();
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    private async launchSshProcess(): Promise<void> {
        if (!this.config.sshExecutable || !this.config.sshArgs) {
            throw new Error('Native SSH helper requires a command and argument array.');
        }

        const processHandle = await spawnNativeSshProcess(
            this.config.sshExecutable,
            this.config.sshArgs,
        );
        const child = processHandle.child;
        this.sshProcess = processHandle;

        console.log(`[ssh-process] Executed ${this.config.sshExecutable} ${this.config.sshArgs.join(' ')}`);
        console.log(`[ssh-process] Ssh process pid=${child.pid}`);

        child.stdout.on('data', (chunk: Buffer | string) => process.stdout.write(chunk));
        child.stderr.on('data', (chunk: Buffer | string) => process.stderr.write(chunk));
        child.once('error', () => this.close());
        child.once('close', (code) => {
            if (code && code !== 0) {
                process.exitCode = code;
            }
            this.close();
        });
    }

    async start(): Promise<void> {
        return await new Promise<void>((resolve, reject) => {
            const handleError = (error: Error) => {
                this.server.removeListener('listening', handleListening);
                reject(error);
            };
            const handleListening = async () => {
                try {
                    if (this.config.sshExecutable) {
                        await this.launchSshProcess();
                    }
                    this.resetIdleTimer();
                    resolve();
                } catch (error: unknown) {
                    this.close();
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            };

            this.server.once('error', handleError);
            this.server.once('listening', handleListening);
            this.server.listen(this.config.socketPath);
        });
    }

    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(() => this.close(), HELPER_IDLE_TIMEOUT_MS);
        this.idleTimer.unref();
    }

    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        this.sshProcess?.close();
        this.sshProcess = undefined;
        this.server.close();
        if (process.platform !== 'win32' && fs.existsSync(this.config.socketPath)) {
            fs.unlinkSync(this.config.socketPath);
        }
        removeNativeSshHelperRegistry(this.config.registryFilePath, process.pid);
    }
}

function startHelperFromArguments(): void {
    try {
        const serializedConfig = process.argv[2];
        if (!serializedConfig) {
            throw new Error('Native SSH helper startup requires serialized configuration.');
        }
        const config = JSON.parse(serializedConfig) as NativeSshServerConfig;
        if (
            typeof config.sshExecutable !== 'string' ||
            !Array.isArray(config.sshArgs) ||
            !config.sshArgs.every((arg) => typeof arg === 'string') ||
            typeof config.registryFilePath !== 'string' ||
            typeof config.socketPath !== 'string'
        ) {
            throw new Error('Native SSH helper configuration must include a command, string argument array, and registry file path.');
        }

        const server = new NativeSshHelperServer(config);
        process.once('exit', () => removeNativeSshHelperRegistry(config.registryFilePath, process.pid));
        server.start().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ssh-server] ${message}`);
            process.exitCode = 1;
            server.close();
        });
        process.once('SIGINT', () => server.close());
        process.once('SIGTERM', () => server.close());
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ssh-server] ${message}`);
        process.exitCode = 1;
    }
}

type NativeSshProcess = {
    child: cp.ChildProcessByStdio<null, stream.Readable, stream.Readable>;
    close(): void;
};

async function spawnNativeSshProcess(
    command: string,
    args: string[],
): Promise<NativeSshProcess> {
    const child = cp.spawn(command, args, {
        stdio: ['inherit', 'pipe', 'pipe'],
        windowsHide: true,
    });

    let closed = false;
    return {
        child,
        close: () => {
            if (closed) {
                return;
            }
            closed = true;
            if (child.exitCode === null && !child.killed) {
                child.kill();
            }
        },
    };
}

if (path.basename(process.argv[1] ?? '') === 'nativeSshServer.js') {
    startHelperFromArguments();
}
