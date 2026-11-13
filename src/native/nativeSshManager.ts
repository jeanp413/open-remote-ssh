import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import * as path from 'path';
import { exists } from '../common/files';
import { disposableTimeout, timeout, TimeoutTimer } from '../common/async';
import { ILogger } from '../common/logger';
import { AUTH_CONFIRMED_RE, CommandRunner, LineParser } from './nativeSshParser';
import { isWindows, platform, RemotePlatform } from '../common/platform';
import { NativeSshServerClient, NativeSshKeepalive } from './nativeSshServerClient';
import { Architecture, buildServerInstallOptions, generateBashInstallScript, generatePowerShellInstallScript, LocalDownloadRequest, parseKernelName, parseLocalDownloadMarker, parseMachineArch, parseServerInstallOutput, Platform, resolveServerDownloadUrl, ServerInstallError, ServerInstallOptions, ServerInstallResult } from '../serverSetup';
import { ServerVersion } from '../server-config/types';
import { computeScpArgs, computeSshArgs, getNativeSshSocketPath } from './nativeSshConnection';
import SSHDestination from '../ssh/sshDestination';
import { NativeSshRegistry, NativeSshRegistryEntry } from './nativeSshRegistry';
import type { NativeSshServerConfig } from './nativeSshServer';
import { quote } from '../common/quote';
import { IDisposable } from '../common/disposable';

export interface NativeSshConnectionOptions {
    authorityKey: string;
    sshExecutable: string;
    sshArgs: string[];
    scpExecutable: string;
    scpArgs: string[];
    label: string;
    remotePlatform: RemotePlatform | undefined;
    socksPort: number;
    sshDestination: SSHDestination;
}

type NativeSshServerInfo = {
    socketPath: string;
    pid: number;
    reused: boolean;
};

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
    localServerDownload: 'auto' | 'always' | 'off';
}

const SCHEMA_VERSION = 1;
const SERVER_READY_TIMEOUT_MS = 10_000;
const SERVER_READY_POLL_MS = 100;

export class NativeSshManager {
    private serverProcess: cp.ChildProcess | undefined;
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
            await this.waitAuthSucceeded();
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

    private waitAuthSucceeded() {
        if (!this.stdoutParser || !this.stderrParser) {
            throw new Error('No local server output parser attached');
        }

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (err: Error | undefined): void => {
                if (settled) {
                    return;
                }
                settled = true;
                stdoutSubscription.dispose();
                stderrSubscription.dispose();
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };

            const predicate = (line: string) => {
                return AUTH_CONFIRMED_RE.test(line);
            };

            const stdoutSubscription = this.stdoutParser!.subscribe({
                onLine: (line) => {
                    try {
                        if (predicate(line)) {
                            finish(undefined);
                        }
                    } catch (e) {
                        finish(e);
                    }
                },
                onError: (reason) => finish(new Error(reason)),
            });
            const stderrSubscription = this.stderrParser!.subscribe({
                onLine: (line) => {
                    try {
                        if (predicate(line)) {
                            finish(undefined);
                        }
                    } catch (e) {
                        finish(e);
                    }
                },
                onError: (reason) => finish(new Error(reason)),
            });
        });
    }

    async runCommand<T>(
        command: string,
        predicate: (stdout: string | undefined, stderr: string | undefined) => T | undefined,
        options: { signal?: AbortSignal; timeout?: number }
    ): Promise<T> {
        if (!this.cmdRunner) {
            throw new Error('No helper process owned by this window.');
        }

        let disposable: IDisposable | undefined;
        let signal = options.signal;
        if (!signal) {
            const ms = options.timeout || 10_000;
            const controller = new AbortController();
            disposable = disposableTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
            signal = controller.signal;
        }

        return this.cmdRunner.run(command, predicate, signal)
            .finally(()=>{
                disposable?.dispose();
            });
    }

    private async nativeDetectPlatform(
        platform: RemotePlatform | undefined,
    ): Promise<NativeDetectedPlatform> {
        let detectedPlatform: Platform;

        if (!platform || platform === 'windows') {
            const stdout = await this.runCommand('echo %COMSPEC%~$PSHOME', (stdout) => {
                return stdout;
            }, { timeout: 10_000 });
            const [comspec, pshome = ''] = stdout.replace(/\r?\n/g, ' ').trim().split('~');

            if (comspec && comspec !== '%COMSPEC%') {
                detectedPlatform = 'windows';
            } else if (pshome) {
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
                }, { timeout: 10_000 });
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

        this.options.logger.trace(`Detected platform: ${detectedPlatform}`);

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
            }, { timeout: 10_000 });
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
        return { detectedPlatform, detectedArch };
    }

    private async waitRemoteShellReady() {
        const readyMarker = `==${this.connection.label}==`;
        await this.runCommand(`echo '${readyMarker}'`, (stdout: string | undefined) => {
            if (stdout?.includes(readyMarker)) {
                return true;
            }
            return undefined;
        }, { timeout: 10_000 });
    }

    private async probeRemotePlatform(): Promise<RemotePlatform> {
        return this.runCommand('uname -rsv', (stdout: string | undefined, stderr: string | undefined) => {
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
        }, { timeout: 10_000 });
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
            localServerDownload
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
            localServerDownload,
            this.options.logger,
        );

        let remoteCmd: string;
        if (detectedPlatform === 'windows') {
            await this.waitPowershellReady();

            const encoded = Buffer.from(generatePowerShellInstallScript(installOptions, extensionPath), 'utf8').toString('base64');

            remoteCmd = `powershell -NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -Command "iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))"`;
            if (remoteCmd.length > 8191) {
                throw new Error(`Script length ${remoteCmd.length} exceeds the maximun limit of 8191`);
            }
        } else {
            await this.waitBashReady();

            remoteCmd = `scriptWrapper() {\n ${generateBashInstallScript(installOptions, extensionPath)}\n }\n scriptWrapper`;
        }

        const controller = new AbortController();
        const timer = new TimeoutTimer(() => controller.abort(), 90_000);

        let localDownloadDispatched = false;

        let stdoutBuffer = '';
        let stderrBuffer = '';
        const commandOutput = await this.runCommand(
            remoteCmd,
            (stdout: string | undefined, stderr: string | undefined) => {
                if (stdout !== undefined) {
                    stdoutBuffer += stdout + '\n';
                }
                if (stderr !== undefined) {
                    stderrBuffer += stderr + '\n';
                }

                if (stdout?.includes(`${installOptions.id}: local-download-request-end`) && !localDownloadDispatched) {
                    localDownloadDispatched = true;

                    const downloadRequest = parseLocalDownloadMarker(stdoutBuffer, installOptions.id);
                    if (!downloadRequest) {
                        throw new ServerInstallError('Failed parsing local download request');
                    }

                    timer.cancelAndSet(() => controller.abort(), 300_000);
                    this.runLocalDownloadAndTransfer(installOptions, downloadRequest);
                }

                if (stdout?.includes(`${installOptions.id}: end`)) {
                    return { stdout: stdoutBuffer, stderr: stderrBuffer };
                }
                return undefined;
            },
            { signal: controller.signal }
        );

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

        const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

        return {
            exitCode,
            listeningOn,
            connectionToken: resultMap.connectionToken,
            logFile: resultMap.logFile,
            osReleaseId: resultMap.osReleaseId,
            arch: resultMap.arch || installOptions.serverArch,
            platform: resultMap.platform,
            tmpDir: resultMap.tmpDir,
            ...remoteEnvVars
        };
    }

    private async waitBashReady(): Promise<void> {
        const readyMarker = `==${this.connection.label}==`;
        await this.runCommand(`bash -c 'echo ${readyMarker}; exec bash'`, (stdout: string | undefined) => {
            if (stdout?.includes(readyMarker)) {
                return true;
            }
            return undefined;
        }, { timeout: 10_000 });
    }

    private async waitPowershellReady(): Promise<void> {
        await this.runCommand('powershell -NoProfile', (stdout: string | undefined) => {
            if (stdout?.includes('Windows PowerShell')) {
                return true;
            }
            return undefined;
        }, { timeout: 10_000 });
    }

    private async spawnFresh(): Promise<NativeSshServerInfo> {
        const serverScriptPath = this.options.serverScriptPath;
        if (!await exists(serverScriptPath)) {
            throw new Error(`Native SSH local server entrypoint was not found: ${serverScriptPath}`);
        }

        const serverConfig: NativeSshServerConfig = {
            sshExecutable: this.connection.sshExecutable,
            sshArgs: computeSshArgs(this.connection.sshDestination, this.connection.sshArgs),
            socketPath: getNativeSshSocketPath('sshServer'),
            registryFilePath: this.registry.filePath
        };

        const envVars = {
            DISPLAY: process.env.DISPLAY || '1',
            ELECTRON_RUN_AS_NODE: '1',
            SSH_ASKPASS: this.options.askpassPath,
            SSH_ASKPASS_REQUIRE: 'force',
            NATIVE_SSH_NODE_BIN: process.execPath,
            NATIVE_SSH_ASKPASS_NODE_SCRIPT: this.options.askpassNodeScriptPath,
            NATIVE_SSH_ASKPASS_SOCKET: this.options.askpassSocketPath,
        };
        const child = cp.spawn(process.execPath, [serverScriptPath, JSON.stringify(serverConfig)], {
            detached: true,
            stdio: 'pipe',
            env: {
                ...process.env,
                ...envVars
            },
        });
        child.unref();

        child.stdout?.on('error', (err) => this.options.logger.error(`ssh server stdout error: ${err.message}`));
        child.stderr?.on('error', (err) => this.options.logger.error(`ssh server stderr error: ${err.message}`));
        child.stdin?.on('error', (err) => this.options.logger.error(`ssh server stdin error: ${err.message}`));

        let spawnError: Error | undefined;
        child.once('error', (error) => {
            spawnError = error;
            this.options.logger.error(`ssh server spawn failed: ${error.message}`);
        });

        child.once('close', (code, signal) => {
            const reason = code !== null
                ? `ssh server closed (code=${code})`
                : `ssh server killed (signal=${signal ?? 'unknown'})`;
            this.stdoutParser?.end(reason);
            this.stderrParser?.end(reason);
            this.stdoutParser = undefined;
            this.stderrParser = undefined;
            this.cmdRunner = undefined;
            this.keepalive?.dispose();

            if (code !== null) {
                this.options.logger.info(`ssh server pid=${child.pid} exited code=${code}`);
            } else {
                this.options.logger.info(`ssh server pid=${child.pid} killed by signal=${signal ?? 'unknown'}`);
            }
        });

        const pid = child.pid;
        if (!pid) {
            throw new Error('Native SSH local server failed to spawn: no pid assigned.');
        }
        this.options.logger.info(`Spawned ssh server pid=${pid} socket=${serverConfig.socketPath} env=${JSON.stringify(envVars)}`);

        this.serverProcess = child;
        this.attachParsers();

        await this.waitUntilSshServerReady(serverConfig.socketPath, () => spawnError, SERVER_READY_TIMEOUT_MS);

        return {
            pid,
            socketPath: serverConfig.socketPath,
            reused: false
        };
    }

    private attachParsers(): void {
        const child = this.serverProcess!;
        const stdout = child.stdout!;
        const stderr = child.stderr!;
        const stdin = child.stdin!;

        stdout.setEncoding('utf8');
        stderr.setEncoding('utf8');

        this.stdoutParser = new LineParser({ onLine: (line) => this.options.logger.info(`[local-server] ${line}`) });
        this.stderrParser = new LineParser({ onLine: (line) => this.options.logger.error(`[local-server] ${line}`) });

        this.cmdRunner = new CommandRunner(
            this.stdoutParser,
            this.stderrParser,
            (data) => new Promise<void>((resolve, reject) => {
                stdin.write(data + '\n', (err) => err ? reject(err) : resolve());
            }),
        );

        stdout.on('data', (chunk: string) => this.stdoutParser!.push(chunk));
        stderr.on('data', (chunk: string) => this.stderrParser!.push(chunk));
    }

    private async waitUntilSshServerReady(
        socketPath: string,
        checkSpawnError: () => Error | undefined,
        timeoutMs: number
    ): Promise<void> {
        const client = new NativeSshServerClient(socketPath);
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const err = checkSpawnError();
            if (err) {
                throw err;
            }

            if (await client.isHealthy()) {
                return;
            }

            await timeout(SERVER_READY_POLL_MS);
        }

        throw new Error(
            `Native SSH local server did not become ready within ${Math.floor(timeoutMs / 1000)}s`
        );
    }

    private async runLocalDownloadAndTransfer(
        installOptions: ServerInstallOptions,
        request: LocalDownloadRequest,
    ): Promise<void> {
        const waitForTerminal = (terminal: vscode.Terminal) =>{
            return new Promise<void>((resolve) => {
                const finish = () => {
                    closeSub.dispose();
                    resolve();
                };

                const closeSub = vscode.window.onDidCloseTerminal((t) => {
                    if (t === terminal) {
                        finish();
                    }
                });
            });
        };

        let serverPath: string | undefined;
        let localMarkerPath: string | undefined;
        try {
            const url = await resolveServerDownloadUrl(installOptions, request);
            this.options.logger.info(`[local-download] downloading ${url}`);
            const downloadPath = await vscode.commands.executeCommand<vscode.Uri>('_workbench.downloadResource',vscode.Uri.parse(url));
            const downloadDir = path.dirname(downloadPath.fsPath);
            const targetDir = path.join(downloadDir, `code_server_${Date.now()}`);
            serverPath = path.join(targetDir, 'vscode-server.tar.gz');
            if (!await exists(targetDir)) {
                await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
            }
            await fs.rename(downloadPath.fsPath, serverPath);

            localMarkerPath = path.join(targetDir, `.server-local-download.done`);
            await fs.writeFile(localMarkerPath, '');

            let cmd = [
                quote(this.options.connection.scpExecutable, platform),
                ...computeScpArgs(
                    this.options.connection.sshDestination,
                    this.options.connection.scpArgs,
                    [serverPath, localMarkerPath],
                    request.serverDir
                )
            ].join(' ');

            if (isWindows) {
                cmd = cmd
                    .replace(/(\\*)"/g, '$1$1\\"')
                    .replace(/(\\+)$/, '$1$1');
            }

            this.options.logger.info(`[local-download] launching scp in terminal: ${cmd}`);

            const terminal = vscode.window.createTerminal({
                name: 'Copy server to host',
                cwd: targetDir,
                shellPath: isWindows ? 'powershell.exe' : '/bin/sh',
                shellArgs: isWindows ? `-NoProfile -Command "${cmd}; exit 0"` : ['-c', `${cmd}\nexit 0`]
            });
            terminal.show(true);
            const completion = waitForTerminal(terminal);
            await completion;

            this.options.logger.info('[local-download] scp terminal idle; remote script will detect outcome via marker');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.options.logger.error(`[local-download] failed: ${message}`);
        } finally {
            if (serverPath) {
                await fs.rm(serverPath, { force: true }).catch(() => undefined);
            }
            if (localMarkerPath) {
                await fs.rm(localMarkerPath, { force: true }).catch(() => undefined);
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.keepalive?.dispose();
        this.keepalive = undefined;
        // The server is detached and self-terminates when keepalives stop.
        this.serverProcess = undefined;
    }
}
