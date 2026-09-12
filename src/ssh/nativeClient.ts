import { spawn } from 'child_process';
// eslint-disable-next-line no-duplicate-imports
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Log } from '../common/logger';
import { findRandomPort } from '../common/ports';
import { isWindows } from '../common/platform';
import type { HostConfiguration } from './sshConfig';
import type { SSHClient, SSHExecChannel } from './sshClient';
import type { SSHTunnelConfig } from './sshConnection';

/** Time between two ControlMaster readiness probes. */
const MASTER_POLL_INTERVAL = 300;
/** Grace period for a killed ssh process to exit on its own before SIGKILL. */
const KILL_GRACE_PERIOD = 2000;
/** Cap on the stderr text kept around for error messages. */
const MAX_STDERR_LENGTH = 8 * 1024;
const SSH_CLIENT = 'ssh';

/**
 * `GSSAPIAuthentication yes` values per ssh_config(5). When a host requests
 * GSSAPI, the connection is delegated to the local `ssh` client: the SSH
 * `gssapi-with-mic` method needs access to the platform Kerberos credentials,
 * which the bundled ssh2 library cannot provide.
 */
const GSSAPI_DIRECTIVE = 'GSSAPIAuthentication';
const GSSAPI_ENABLED_VALUES = new Set(['yes', 'yes-point-to-point']);
const GSSAPI_METHOD = 'gssapi-with-mic';

/**
 * Whether the resolved host configuration asks for GSSAPI authentication,
 * either explicitly via `GSSAPIAuthentication` or by listing
 * `gssapi-with-mic` in `PreferredAuthentications`.
 */
export function isGssapiAuthenticationRequested(hostConfig: HostConfiguration): boolean {
    const gssapiAuth = hostConfig[GSSAPI_DIRECTIVE];
    if (gssapiAuth && GSSAPI_ENABLED_VALUES.has(gssapiAuth.trim().toLowerCase())) {
        return true;
    }

    const preferred = hostConfig['PreferredAuthentications'];
    return !!preferred && preferred.split(',').some(method => method.trim().toLowerCase() === GSSAPI_METHOD);
}

export interface NativeSSHConnectConfig {
    /**
     * The destination passed to the local `ssh` client, as `[user@]hostname`.
     * Given verbatim so ssh_config aliases, ProxyJump/ProxyCommand, and
     * per-host options keep working exactly like on the command line.
     */
    destination: string;
    /** Explicit port from the connection target; when absent ssh_config decides. */
    port?: number;
    /**
     * SSH config file the extension parsed, passed via `-F` so the client
     * interprets the exact same configuration (aliases, GSSAPI, proxies).
     * Should always point at the file `getSSHConfigPath()` resolves to.
     */
    configFile: string;
    /** Open a dynamic (-D) forward alongside the connection for SOCKS tunnels. */
    dynamicForwarding: boolean;
    /** Timeout for establishing the connection, in milliseconds. */
    readyTimeout: number;
    logger: Log;
}

/**
 * Options shared by every local `ssh` invocation:
 * - `-F` keeps the client on the same config file the extension parsed.
 * - `BatchMode=yes` makes the client fail instead of hanging on interactive
 *   prompts (passwords, host key confirmation) — the extension host has no tty.
 *   GSSAPI, agent keys, and passphrase-less identity files keep working.
 * - `ControlPath` routes the invocation through the ControlMaster connection,
 *   so only the very first connection authenticates.
 */
function buildSshOptions(config: NativeSSHConnectConfig, controlPath?: string): string[] {
    const options = ['-F', config.configFile, '-o', 'BatchMode=yes'];
    if (controlPath) {
        options.push('-o', `ControlPath=${controlPath}`);
    }
    return options;
}

/** Explicit `-p` only when the target carries a port; ssh_config wins otherwise. */
function buildPortArgs(port: number | undefined): string[] {
    return port === undefined ? [] : ['-p', String(port)];
}

/** Args for the long-lived ControlMaster that owns the authenticated connection. */
function buildMasterArgs(config: NativeSSHConnectConfig, controlPath: string, socksPort?: number): string[] {
    const args = [
        ...buildSshOptions(config, controlPath),
        '-o', 'ControlMaster=yes',
        '-N', '-T'
    ];
    if (socksPort !== undefined) {
        args.push('-D', `127.0.0.1:${socksPort}`);
    }
    args.push(...buildPortArgs(config.port), '--', config.destination);
    return args;
}

/** Args for a one-shot command executed through the master connection. */
function buildExecArgs(config: NativeSSHConnectConfig, controlPath: string | undefined, cmd: string, params: string[]): string[] {
    return [
        ...buildSshOptions(config, controlPath),
        ...buildPortArgs(config.port),
        '--', config.destination,
        cmd, ...params
    ];
}

/** Args for a forwarding process (-L local forward or -D dynamic SOCKS). */
function buildForwardArgs(config: NativeSSHConnectConfig, controlPath: string | undefined, forwardArgs: string[]): string[] {
    return [
        ...buildSshOptions(config, controlPath),
        '-N', '-T',
        ...forwardArgs,
        ...buildPortArgs(config.port),
        '--', config.destination
    ];
}

/** Args for the `-O check` probe that reports master liveness. */
function buildCheckArgs(config: NativeSSHConnectConfig, controlPath: string): string[] {
    return [...buildSshOptions(config, controlPath), '-O', 'check', '--', config.destination];
}

/** Trims collected stderr for display, keeping the tail where the reason lives. */
function capStderr(text: string): string {
    return text.length > MAX_STDERR_LENGTH ? `…${text.slice(-MAX_STDERR_LENGTH)}` : text;
}

/**
 * Terminates an ssh helper process, giving it a grace period to exit on its
 * own (so ssh can clean up forwards and the ControlPath socket) before
 * escalating to SIGKILL.
 */
function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
    }

    return new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_PERIOD);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

/**
 * Wraps a spawned `ssh <cmd>` process in the narrow channel surface consumed
 * by `authResolver`, mirroring how it consumes an ssh2 `ClientChannel`.
 * `data` listeners attach to the process' stdout stream, whose buffering
 * keeps early output from being lost before a consumer subscribes.
 */
class SSHProcessChannel extends EventEmitter implements SSHExecChannel {
    constructor(private readonly child: ChildProcess) {
        super();
        // The channel is over once the process ends, whatever the reason.
        child.on('close', () => this.emit('close'));
        child.on('error', () => this.emit('close'));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override on(event: string, listener: (...args: any[]) => void): this {
        if (event === 'data') {
            return this.forwardStdout('on', listener);
        }
        return super.on(event, listener);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override removeListener(event: string, listener: (...args: any[]) => void): this {
        if (event === 'data') {
            return this.forwardStdout('removeListener', listener);
        }
        return super.removeListener(event, listener);
    }

    close(): void {
        void killChild(this.child);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private forwardStdout(method: 'on' | 'removeListener', listener: (...args: any[]) => void): this {
        const stdout = this.child.stdout!;
        // Safe: stdout only ever emits Buffer chunks for this listener.
        stdout[method]('data', listener as (chunk: Buffer) => void);
        return this;
    }
}

export default class NativeSSHConnection implements SSHClient {
    private readonly config: NativeSSHConnectConfig;
    /** ControlMaster process owning the single authenticated connection (POSIX only). */
    private master: ChildProcess | undefined;
    private controlPath: string | undefined;
    /** Local port of the `-D` listener opened on the master, when enabled. */
    private masterSocksPort: number | undefined;
    private masterStderr = '';
    private readonly tunnels = new Map<string, { process: ChildProcess; stderr: string }>();

    constructor(config: NativeSSHConnectConfig) {
        this.config = config;
    }

    private get logger(): Log {
        return this.config.logger;
    }

    /**
     * Establish the connection. On POSIX this spawns the ControlMaster and
     * waits until it is authenticated; on Windows, where OpenSSH lacks
     * multiplexing support, a probe command verifies reachability and auth,
     * and every later operation opens its own connection.
     */
    connect(): Promise<SSHClient> {
        return (isWindows ? this.probeConnectivity() : this.spawnMaster().then(() => undefined))
            .then(() => this);
    }

    /** Spawn the ControlMaster: authenticates once, serves every later channel. */
    private spawnMaster(): Promise<void> {
        if (this.config.dynamicForwarding) {
            return findRandomPort().then(port => this.spawnMasterProcess(port));
        }
        return this.spawnMasterProcess(undefined);
    }

    private spawnMasterProcess(socksPort?: number): Promise<void> {
        this.controlPath = path.join(os.tmpdir(), `open-remote-ssh-${randomUUID()}`);
        this.masterSocksPort = socksPort;
        const args = buildMasterArgs(this.config, this.controlPath, socksPort);
        this.logger.trace(`Starting ssh ControlMaster: ${SSH_CLIENT} ${args.join(' ')}`);

        this.master = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        this.master.stderr!.on('data', chunk => {
            this.masterStderr = capStderr(this.masterStderr + chunk.toString());
            this.logger.trace(`ssh ControlMaster: ${chunk.toString().trim()}`);
        });

        return this.waitMasterReady();
    }

    /** Poll `-O check` until the master answers, it dies, or the timeout hits. */
    private waitMasterReady(): Promise<void> {
        const master = this.master!;
        const destination = this.config.destination;
        return new Promise((resolve, reject) => {
            let settled = false;
            const deadline = Date.now() + this.config.readyTimeout;

            const settle = (err?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                master.removeListener('exit', onExit);
                if (err) {
                    return reject(err);
                }
                resolve();
            };

            const onExit = (code: number | null, signal: string | null) => settle(new Error(this.formatMasterError(code, signal)));
            master.once('exit', onExit);

            const poll = () => {
                if (settled) {
                    return;
                }
                this.checkMasterAlive().then(alive => {
                    if (settled) {
                        return;
                    }
                    if (alive) {
                        return settle();
                    }
                    if (Date.now() >= deadline) {
                        return settle(new Error(`Timed out connecting to ${destination} via the local SSH client: ${this.formatMasterError()}`));
                    }
                    setTimeout(poll, MASTER_POLL_INTERVAL);
                });
            };
            poll();
        });
    }

    private checkMasterAlive(): Promise<boolean> {
        const args = buildCheckArgs(this.config, this.controlPath!);
        return new Promise(resolve => {
            const check = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'ignore', 'ignore'] });
            check.on('error', () => resolve(false));
            check.on('close', code => resolve(code === 0));
        });
    }

    private formatMasterError(code?: number | null, signal?: string | null): string {
        const how = code !== undefined && code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : 'before the connection was ready';
        const stderr = this.masterStderr.trim();
        const reason = stderr ? `: ${stderr}` : '';
        return `the ssh process for ${this.config.destination} stopped (${how})${reason}`;
    }

    /**
     * Windows fallback: no ControlMaster exists to probe, so run a no-op
     * command through a regular connection to surface auth/network failures.
     */
    private probeConnectivity(): Promise<void> {
        return this.exec('exit').then(() => undefined);
    }

    async exec(cmd: string, params: string[] = []): Promise<{ stdout: string; stderr: string }> {
        const args = buildExecArgs(this.config, this.controlPath, cmd, params);
        this.logger.trace(`ssh exec: ${SSH_CLIENT} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            const child = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            child.stdout!.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
            child.on('error', reject);
            child.on('close', code => {
                // Exit code 255 with no command output means the ssh client
                // itself failed (auth, network, host key); anything else is
                // the remote command's outcome, mirroring ssh2 semantics.
                if (code === 255 && stdout === '') {
                    return reject(new Error(`ssh command failed on ${this.config.destination}: ${stderr.trim() || `exit code ${code}`}`));
                }
                resolve({ stdout, stderr });
            });
        });
    }

    async execPartial(cmd: string, tester: (stdout: string, stderr: string) => boolean, params: string[] = []): Promise<{ stdout: string; stderr: string }> {
        const args = buildExecArgs(this.config, this.controlPath, cmd, params);
        this.logger.trace(`ssh execPartial: ${SSH_CLIENT} ${args.join(' ')}`);

        return new Promise((resolve, reject) => {
            const child = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let settled = false;

            const finish = (result?: { stdout: string; stderr: string }, err?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (err) {
                    return reject(err);
                }
                resolve(result!);
            };

            const test = () => {
                if (!settled && tester(stdout, stderr)) {
                    finish({ stdout, stderr });
                }
            };

            child.stdout!.on('data', chunk => {
                stdout += chunk.toString();
                test();
            });
            child.stderr!.on('data', chunk => {
                stderr += chunk.toString();
                test();
            });
            child.on('error', reject);
            child.on('close', () => finish({ stdout, stderr }));
        });
    }

    async execChannel(cmd: string): Promise<SSHExecChannel> {
        const args = buildExecArgs(this.config, this.controlPath, cmd, []);
        this.logger.trace(`ssh execChannel: ${SSH_CLIENT} ${args.join(' ')}`);

        const child = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        return new SSHProcessChannel(child);
    }

    async addTunnel(config: SSHTunnelConfig): Promise<SSHTunnelConfig & { server: unknown }> {
        const name = config.name || `${config.remoteAddr}@${config.remotePort || config.remoteSocketPath}`;

        if (config.socks) {
            if (this.masterSocksPort !== undefined) {
                // The master already listens with -D; hand out its port.
                return { ...config, name, localPort: this.masterSocksPort, server: this.master };
            }
            const localPort = config.localPort ?? await findRandomPort();
            const forward = this.spawnForward(['-D', `127.0.0.1:${localPort}`], name);
            await this.waitForwardReady(forward, localPort);
            return { ...config, name, localPort, server: forward.process };
        }

        const localPort = config.localPort ?? await findRandomPort();
        // `-L port:<host:port>` for TCP targets, `-L port:<path>` for remote
        // Unix sockets — OpenSSH picks the variant from the target shape.
        const target = config.remotePort !== undefined
            ? `${config.remoteAddr ?? '127.0.0.1'}:${config.remotePort}`
            : config.remoteSocketPath;
        const forward = this.spawnForward(['-L', `${localPort}:${target}`], name);
        await this.waitForwardReady(forward, localPort);
        return { ...config, name, localPort, server: forward.process };
    }

    /** Spawn a forwarding-only ssh process and track it under `name`. */
    private spawnForward(forwardArgs: string[], name: string): { process: ChildProcess; stderr: string } {
        const args = buildForwardArgs(this.config, this.controlPath, forwardArgs);
        this.logger.trace(`ssh forward: ${SSH_CLIENT} ${args.join(' ')}`);

        const child = spawn(SSH_CLIENT, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const forward = { process: child, stderr: '' };
        child.stderr!.on('data', chunk => {
            forward.stderr = capStderr(forward.stderr + chunk.toString());
        });
        this.tunnels.set(name, forward);
        return forward;
    }

    /** Race the local forward port against early process death. */
    private waitForwardReady(forward: { process: ChildProcess; stderr: string }, localPort: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const deadline = Date.now() + this.config.readyTimeout;
            const child = forward.process;

            const settle = (err?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                child.removeListener('exit', onExit);
                if (err) {
                    return reject(err);
                }
                resolve();
            };

            const onExit = () => settle(new Error(`ssh forward on port ${localPort} failed: ${forward.stderr.trim() || 'the ssh process exited'}`));
            child.once('exit', onExit);

            const tryConnect = () => {
                if (settled) {
                    return;
                }
                const socket = net.connect({ port: localPort, host: '127.0.0.1' });
                socket.once('connect', () => {
                    socket.destroy();
                    settle();
                });
                socket.once('error', () => {
                    socket.destroy();
                    if (Date.now() >= deadline) {
                        return settle(new Error(`Timed out waiting for the ssh forward on port ${localPort}: ${forward.stderr.trim() || this.formatMasterError()}`));
                    }
                    setTimeout(tryConnect, MASTER_POLL_INTERVAL);
                });
            };
            tryConnect();
        });
    }

    async closeTunnel(name?: string): Promise<void> {
        if (name) {
            const forward = this.tunnels.get(name);
            if (forward) {
                this.tunnels.delete(name);
                await killChild(forward.process);
            }
            return;
        }
        for (const tunnelName of [...this.tunnels.keys()]) {
            await this.closeTunnel(tunnelName);
        }
    }

    async close(): Promise<void> {
        await this.closeTunnel();
        if (this.master) {
            const master = this.master;
            this.master = undefined;
            await killChild(master);
        }
    }
}
