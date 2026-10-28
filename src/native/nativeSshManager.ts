import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as stream from 'stream';
import * as vscode from 'vscode';
import { exists } from '../common/files';
import { getProductJson } from '../server-config/get-product-json';
import { sleep } from '../common/sleep';
import { ILogger } from '../common/logger';
import { CommandRunner, LineParser } from './nativeSshParser';
import { RemotePlatform } from '../common/platform';
import { NativeSshServerClient, NativeSshKeepalive } from './nativeSshServerClient';
import { Architecture, buildServerInstallOptions, generateBashInstallScript, generatePowerShellInstallScript, parseKernelName, parseMachineArch, parseServerInstallOutput, Platform, ServerInstallError, ServerInstallResult, Shell } from '../serverSetup';
import { ServerVersion } from '../server-config/types';
import { getNativeSshSocketPath } from './nativeSshConnection';

export interface NativeSshConnectionOptions {
    authorityKey: string;
    sshExecutable: string;
    sshArgs: string[];
    label: string;
    remotePlatform: RemotePlatform | undefined;
    socksPort: number;
}

export type NativeSshRegistryEntry = {
    schemaVersion: number;
    socketPath: string;
    socksPort: number;
    pid: number;
} & ServerInstallResult;

export type NativeSshServerConfig = {
    sshExecutable: string;
    sshArgs: string[];
    socketPath: string;
    registryFilePath: string;
};

export type NativeSshServerInfo = {
    socketPath: string;
    pid: number;
    reused: boolean;
};

export interface NativeSshServerProcess {
    child: cp.ChildProcess;
    stdin: stream.Writable;
    wait(): Promise<number | null>;
    terminate(): Promise<void>;
}

export interface NativeSshManagerOptions {
    connection: NativeSshConnectionOptions;
    registry: NativeSshRegistry;
    serverScriptPath: string;
    askpassPath: string;
    askpassNodeScriptPath: string;
    askpassSocketPath: string;
    logger: ILogger;
}

interface NativeDetectedPlatform {
    detectedPlatform: Platform;
    detectedArch: Architecture;
    detectedShell: Shell;
}

export interface NativeInstallInputs {
    serverDownloadUrlTemplate: string | undefined;
    serverVersion: ServerVersion;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    customInstallPath: string | undefined;
    extensionPath: string;
    remotePlatform: RemotePlatform | undefined;
}

const SCHEMA_VERSION = 1;
const SERVER_READY_TIMEOUT_MS = 10_000;
const SERVER_READY_POLL_MS = 100;
const SERVER_INSTALL_TIMEOUT_MS = 300_000;

export class NativeSshRegistry {
    private constructor(private readonly registryFilePath: string) { }

    static async forAuthority(
        globalStorageDir: string,
        authorityKey: string,
    ): Promise<NativeSshRegistry> {
        const productJson = await getProductJson();
        return new NativeSshRegistry(
            path.join(
                globalStorageDir,
                'native-ssh',
                `ssh-host-${authorityKey}-${productJson.commit as string}-${vscode.version.replace('-insider','')}`,
                'data.json'
            )
        );
    }

    get filePath(): string {
        return this.registryFilePath;
    }

    async read(): Promise<NativeSshRegistryEntry | undefined> {
        try {
            const raw = await fs.readFile(this.registryFilePath, 'utf8');
            const parsed = JSON.parse(raw) as NativeSshRegistryEntry;
            return isValidRegistryEntry(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    async write(entry: NativeSshRegistryEntry): Promise<void> {
        await fs.mkdir(path.dirname(this.registryFilePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.registryFilePath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
        await fs.rename(tmp, this.registryFilePath);
    }

    async removeIfOwnedBy(pid: number): Promise<void> {
        const entry = await this.read();
        if (!entry || entry.pid !== pid) {
            return;
        }
        try {
            await fs.unlink(this.registryFilePath);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
    }
}

function isValidRegistryEntry(value: unknown): value is NativeSshRegistryEntry {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return (
        typeof v.socketPath === 'string' && v.socketPath.length > 0 &&
        typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 &&
        typeof v.connectionToken === 'string' && v.connectionToken.length > 0 &&
        (
            typeof v.listeningOn === 'string' && v.listeningOn.length > 0 ||
            typeof v.listeningOn === 'number' && Number.isInteger(v.listeningOn) && v.listeningOn > 0
        )
    );
}

export class NativeSshManager {
    private serverProcess: NativeSshServerProcess | undefined;
    private serverInfo: NativeSshServerInfo | undefined;
    private stdoutParser: LineParser | undefined;
    private stderrParser: LineParser | undefined;
    private cmdRunner: CommandRunner | undefined;
    private keepalive: NativeSshKeepalive | undefined;
    private closed = false;

    constructor(private readonly options: NativeSshManagerOptions) { }

    private get connection(): NativeSshConnectionOptions { return this.options.connection; }
    private get registry(): NativeSshRegistry { return this.options.registry; }

    async initialize(installScriptInputs: NativeInstallInputs): Promise<NativeSshRegistryEntry> {
        let registryEntry = await this.acquire();
        if (!registryEntry) {
            await this.waitRemoteShellReady();

            const platform = await this.probeRemotePlatform();
            this.options.logger.info(`Detected remote platform: ${platform}`);

            const result = await this.nativeInstallCodeServer(installScriptInputs);

            registryEntry = {
                schemaVersion: SCHEMA_VERSION,
                socketPath: this.serverInfo!.socketPath,
                pid: this.serverInfo!.pid,
                socksPort: this.connection.socksPort,
                ...result
            };
            await this.registry.write(registryEntry);
        }
        return registryEntry;
    }

    private async acquire(): Promise<NativeSshRegistryEntry | undefined> {
        const existing = await this.registry.read();
        if (existing) {
            const client = new NativeSshServerClient(existing.socketPath);
            if (await client.isHealthy()) {
                this.startKeepalive(client);
                this.options.logger.info(`Adopting local server pid=${existing.pid} socket=${existing.socketPath}`);
                this.serverInfo = { socketPath: existing.socketPath, pid: existing.pid, reused: true };
                return existing;
            }
            this.options.logger.info(`Registry entry for pid=${existing.pid} is stale; removing`);
            await this.registry.removeIfOwnedBy(existing.pid);
        }

        const info = await this.spawnFresh();
        this.startKeepalive(new NativeSshServerClient(info.socketPath));
        this.serverInfo = info;

        return undefined;
    }

    private startKeepalive(client: NativeSshServerClient): void {
        if (this.keepalive) {
            return;
        }
        this.keepalive = new NativeSshKeepalive(client, this.options.logger);
        this.keepalive.start();
    }

    async runCommand<T>(
        command: string,
        predicate: (stdout: string | undefined, stderr: string | undefined) => T | undefined,
        timeout?: number,
    ): Promise<T> {
        if (!this.cmdRunner) {
            throw new Error('No helper process owned by this window.');
        }
        return this.cmdRunner.run(command, predicate, timeout);
    }

    private async nativeDetectPlatform(
        platform: RemotePlatform | undefined,
    ): Promise<NativeDetectedPlatform> {
        let detectedPlatform: Platform;
        let detectedShell: Shell = 'bash';

        if (!platform || platform === 'windows') {
            const stdout = await this.runCommand('echo %COMSPEC%~$PSHOME', (stdout) =>{
                return stdout;
            });
            const [comspec, pshome = ''] = stdout.replace(/\r?\n/g, ' ').trim().split('~');

            if (comspec && comspec !== '%COMSPEC%') {
                detectedPlatform = 'windows';
                detectedShell = 'cmd';
            } else if (pshome) {
                detectedShell = 'powershell';
                detectedPlatform ||= /^[A-Za-z]:\\/.test(pshome) ? 'windows' : 'linux';
            } else if (!platform) {
                const result = await this.runCommand('echo "==$(uname -s)=="', (stdout, stderr) => {
                    if (stderr) {
                        return { stderr };
                    }
                    if (stdout) {
                        return { stdout };
                    }
                    return undefined;
                });
                if (result.stderr) {
                    throw new ServerInstallError(`Cannot execute "uname -s", yields: ${result.stderr}`);
                }
                const uname = /==\s*(.+?)\s*==/.exec(result.stdout!);
                if (!uname) {
                    throw new ServerInstallError(`Platform not found: ${result.stdout}`);
                }
                detectedPlatform = parseKernelName(uname[1].trim());
            } else {
                detectedPlatform = 'windows';
            }
        } else if (platform === 'macos') {
            detectedPlatform = 'darwin';
        } else {
            detectedPlatform = 'linux';
        }

        this.options.logger.trace(`Detected platform: ${detectedPlatform}, ${detectedShell}`);

        let detectedArch: Architecture;
        if (detectedPlatform === 'windows') {
            detectedArch = 'x64';
        } else {
            const result = await this.runCommand('echo "==$(uname -m)=="', (stdout, stderr) => {
                    if (stderr) {
                        return { stderr };
                    }
                    if (stdout) {
                        return { stdout };
                    }
                    return undefined;
            });
            if (result.stderr) {
                throw new ServerInstallError(`Cannot execute "uname -m", yields: ${result.stderr}`);
            }

            const uname = /==\s*(.+?)\s*==/.exec(result.stdout!);
            if (!uname) {
                throw new ServerInstallError(`Architecture not found: ${result.stdout}`);
            }
            detectedArch = parseMachineArch(uname[1].trim());
        }

        this.options.logger.trace(`Detected architecture: ${detectedArch}`);
        return { detectedPlatform, detectedArch, detectedShell };
    }

    private async waitRemoteShellReady() {
        const readyMarker = `==${this.connection.label}==`;
        // Allow time for interactive authentication before the remote shell is ready.
        await this.runCommand(`echo '${readyMarker}'`, (stdout: string | undefined) =>{
            if (stdout?.includes(readyMarker)) {
                return true;
            }
            return undefined;
        }, 120_000);
    }

    private async probeRemotePlatform(): Promise<RemotePlatform> {
        return this.runCommand('uname -rsv', (stdout: string | undefined, stderr: string | undefined) =>{
            if (stdout) {
                const lower = stdout.toLowerCase();
                if (lower.includes('darwin') || lower.includes('macos') || lower.includes('mac os x')) {
                    return 'macos';
                }
                if (lower.includes('linux')) {
                    return 'linux';
                }
                if (lower.includes('cygwin') || lower.includes('mingw') || lower.includes('windows')) {
                    return 'windows';
                }
            } else if (stderr) {
                const lower = stderr.toLowerCase();
                if (lower.includes(`'uname'`)) {
                    // No 'uname' command found
                    return 'windows';
                }
            }
            return undefined;
        });
    }

    private async nativeInstallCodeServer(
        inputs: NativeInstallInputs,
    ): Promise<ServerInstallResult> {
        const {
            serverDownloadUrlTemplate,
            serverVersion,
            extensionIds,
            envVariables,
            useSocketPath,
            customInstallPath,
            extensionPath,
        } = inputs;

        const { detectedPlatform, detectedArch } = await this.nativeDetectPlatform(inputs.remotePlatform);

        const { options: installOptions } = await buildServerInstallOptions(
            this.options.connection.label,
            serverDownloadUrlTemplate,
            serverVersion,
            extensionIds,
            envVariables,
            {},
            useSocketPath,
            customInstallPath,
            detectedPlatform,
            detectedArch,
            true,
            this.options.logger,
        );

        let commandOutput: { stdout: string; stderr: string };
        if (detectedPlatform === 'windows') {
            commandOutput = await this.runNativeWindowsInstall(
                generatePowerShellInstallScript(installOptions, extensionPath),
            );
        } else {
            await this.waitBashReady();

            let stdoutBuffer = '';
            let stderrBuffer = '';
            commandOutput = await this.runCommand(
                `scriptWrapper() {\n ${generateBashInstallScript(installOptions, extensionPath)}\n }\n scriptWrapper`,
                (stdout, stderr) => {
                    if (stdout !== undefined) {
                        stdoutBuffer += stdout + '\n';
                    }
                    if (stderr !== undefined) {
                        stderrBuffer += stderr + '\n';
                    }
                    if (stdout?.includes(`${this.options.connection.label}: end`)) {
                        return { stdout: stdoutBuffer, stderr: stderrBuffer };
                    }
                    return undefined;
                },
                SERVER_INSTALL_TIMEOUT_MS,
            );
        }

        this.options.logger.trace('Server install stdout:', commandOutput.stdout);
        if (commandOutput.stderr) {
            this.options.logger.trace('Server install stderr:', commandOutput.stderr);
        }

        const resultMap = parseServerInstallOutput(commandOutput.stdout, installOptions.id);
        if (!resultMap) {
            throw new ServerInstallError('Failed parsing install script output');
        }
        const exitCode = parseInt(resultMap.exitCode, 10);
        if (exitCode !== 0) {
            throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
        }

        const listeningOn = resultMap.listeningOn.match(/^\d+$/)
            ? parseInt(resultMap.listeningOn, 10)
            : resultMap.listeningOn;

        return {
            exitCode,
            listeningOn,
            connectionToken: resultMap.connectionToken,
            logFile: resultMap.logFile,
            osReleaseId: resultMap.osReleaseId,
            arch: resultMap.arch || installOptions.serverArch,
            platform: resultMap.platform,
            tmpDir: resultMap.tmpDir,
        };
    }

    private async waitBashReady(): Promise<void> {
        const readyMarker = `==${this.connection.label}==`;
        await this.runCommand(`bash -c 'echo ${readyMarker}; exec bash'`, (stdout: string | undefined) =>{
            if (stdout?.includes(readyMarker)) {
                return true;
            }
            return undefined;
        });
    }

    private async runNativeWindowsInstall(
        script: string,
    ): Promise<{ stdout: string; stderr: string }> {
        const remoteTemp = `$env:TEMP\\native-ssh-install-${this.options.connection.label}.ps1`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');

        const writeResult = await this.runCommand(
            `[IO.File]::WriteAllBytes(${remoteTemp}, [Convert]::FromBase64String('${encoded}'))`,
            (stdout, stderr) => {
                if (stderr !== undefined) {
                    return { stderr };
                }
                if (stdout !== undefined) {
                     return { stdout };
                }
                return undefined;
            }
        );
        if (writeResult.stderr && writeResult.stderr.length > 0) {
            this.options.logger.error('Failed writing remote install script:', writeResult.stderr);
            throw new ServerInstallError('Failed writing remote install script');
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';
        const runResult = await this.runCommand(
            `powershell -ExecutionPolicy Bypass -File "${remoteTemp}"; Remove-Item -Force "${remoteTemp}"`,
            (stdout, stderr) => {
                if (stdout !== undefined) {
                    stdoutBuffer += stdout + '\n';
                }
                if (stderr !== undefined) {
                    stderrBuffer += stderr + '\n';
                }
                if (stdout?.includes(`${this.options.connection.label}: end`)) {
                    return { stdout: stdoutBuffer, stderr: stderrBuffer };
                }
                return undefined;
            },
            SERVER_INSTALL_TIMEOUT_MS,
        );
        return runResult;
    }

    private async spawnFresh(): Promise<NativeSshServerInfo> {
        const serverScriptPath = this.options.serverScriptPath;
        if (!await exists(serverScriptPath)) {
            throw new Error(`Native SSH local server entrypoint was not found: ${serverScriptPath}`);
        }

        const serverConfig: NativeSshServerConfig = {
            sshExecutable: this.connection.sshExecutable,
            sshArgs: this.connection.sshArgs,
            socketPath: getNativeSshSocketPath('localSshServer'),
            registryFilePath: this.registry.filePath
        };

        const child = cp.spawn(process.execPath, [serverScriptPath, JSON.stringify(serverConfig)], {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                DISPLAY: process.env.DISPLAY || '1',
                ELECTRON_RUN_AS_NODE: '1',
                SSH_ASKPASS: this.options.askpassPath,
                NATIVE_SSH_NODE_BIN: process.execPath,
                NATIVE_SSH_ASKPASS_NODE_SCRIPT: this.options.askpassNodeScriptPath,
                NATIVE_SSH_ASKPASS_SOCKET: this.options.askpassSocketPath,
            },
        });

        child.stdout?.on('error', (err) => this.options.logger.error(`ssh server stdout error: ${err.message}`));
        child.stderr?.on('error', (err) => this.options.logger.error(`ssh server stderr error: ${err.message}`));
        child.stdin?.on('error', (err) => this.options.logger.error(`ssh server stdin error: ${err.message}`));

        let spawnError: Error | undefined;
        child.once('error', (error) => {
            spawnError = error;
            this.options.logger.error(`ssh server spawn failed: ${error.message}`);
        });

        const pid = child.pid;
        if (!pid) {
            throw new Error('Native SSH local server failed to spawn: no pid assigned.');
        }
        this.options.logger.info(`Spawned ssh server pid=${pid} socket=${serverConfig.socketPath}`);

        await this.waitUntilSshServerReady(serverConfig.socketPath, () => spawnError);

        const proc: NativeSshServerProcess = {
            child,
            stdin: child.stdin!,
            wait: () => new Promise<number | null>((resolve) => {
                if (child.exitCode !== null) {
                    return resolve(child.exitCode);
                }
                child.once('close', (code) => resolve(code));
            }),
            terminate: async () => {
                if (child.exitCode !== null || child.signalCode !== null) {
                    return;
                }
                child.stdin?.end();
                child.kill('SIGTERM');
                const timer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill('SIGKILL');
                    }
                }, 2_000);
                timer.unref();
                await new Promise<void>((resolve) => {
                    if (child.exitCode !== null || child.signalCode !== null) {
                        return resolve();
                    }
                    child.once('close', () => resolve());
                });
                clearTimeout(timer);
            },
        };

        this.serverProcess = proc;
        this.attachParsers(proc, pid);

        return {
            pid,
            socketPath: serverConfig.socketPath,
            reused: false
        };
    }

    private attachParsers(proc: NativeSshServerProcess, pid: number): void {
        const stdout = proc.child.stdout!;
        const stderr = proc.child.stderr!;

        stdout.setEncoding('utf8');
        stderr.setEncoding('utf8');

        this.stdoutParser = new LineParser({ onLine: (line) => this.options.logger.info(`[local-server] ${line}`) });
        this.stderrParser = new LineParser({ onLine: (line) => this.options.logger.error(`[local-server] ${line}`) });

        this.cmdRunner = new CommandRunner(
            this.stdoutParser,
            this.stderrParser,
            (data) => new Promise<void>((resolve, reject) => {
                this.serverProcess!.stdin.write(data + '\n', (err) => err ? reject(err) : resolve());
            }),
        );

        stdout.on('data', (chunk: string) => this.stdoutParser!.push(chunk));
        stderr.on('data', (chunk: string) => this.stderrParser!.push(chunk));

        proc.child.once('close',  (code, signal) => {
            const reason = code !== null
                ? `ssh server closed (code=${code})`
                : `ssh server killed (signal=${signal ?? 'unknown'})`;
            this.stdoutParser?.end(reason);
            this.stderrParser?.end(reason);
            this.stdoutParser = undefined;
            this.stderrParser = undefined;
            this.cmdRunner = undefined;

            if (code !== null) {
                this.options.logger.info(`ssh server pid=${pid} exited code=${code}`);
            } else {
                this.options.logger.info(`ssh server pid=${pid} killed by signal=${signal ?? 'unknown'}`);
            }
        });
    }

    private async waitUntilSshServerReady(
        socketPath: string,
        checkSpawnError: () => Error | undefined,
    ): Promise<void> {
        const client = new NativeSshServerClient(socketPath);
        const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const err = checkSpawnError();
            if (err) {
                throw err;
            }

            if (await client.isHealthy()) {
                return;
            }

            await sleep(SERVER_READY_POLL_MS);
        }

        throw new Error(
            `Native SSH local server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`
        );
    }

    async dispose(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.keepalive?.dispose();
        this.keepalive = undefined;
        if (this.serverProcess) {
            await this.serverProcess.terminate();
            this.serverProcess = undefined;
        }
    }
}
