import * as fs from 'fs';
import * as net from 'net';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { checkDefaultIdentityFiles } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer } from './serverSetup';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private sshConnection: SSHConnection | undefined;
    private sshDest!: SSHDestination;
    private sshHostConfig!: Record<string, string>;
    private identityFiles!: string[];

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private passwordRetryCount: number = PASSWORD_RETRY_COUNT;

    private labelFormatterDisposable : vscode.Disposable| undefined;

    constructor(readonly logger: Log) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attemp #${context.resolveAttempt})`);

        this.sshDest = SSHDestination.parse(dest);
        this.passwordRetryCount = PASSWORD_RETRY_COUNT;

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate', 'https://github.com/VSCodium/vscodium/releases/download/${version}/vscodium-reh-linux-${arch}-${version}.tar.gz')!;
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${this.sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                this.identityFiles = await this.gatherIdentityFiles();

                this.sshConnection = new SSHConnection({
                    host: this.sshDest.hostname,
                    username: this.sshDest.user,
                    readyTimeout: 90000,
                    strictVendor: false,
                    authHandler: (arg0, arg1, arg2) => (this.sshAuthHandler(arg0, arg1, arg2), undefined)
                });

                await this.sshConnection.connect();

                const installResult = await installCodeServer(this.sshConnection, serverDownloadUrlTemplate, defaultExtensions, remoteServerListenOnSocket, this.logger);
                if (installResult.exitCode !== 0) {
                    throw new Error(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
                }

                if (enableDynamicForwarding) {
                    const socksPort = await findRandomPort();
                    this.socksTunnel = await this.sshConnection!.addTunnel({
                        name: `ssh_tunnel_socks_${socksPort}`,
                        localPort: socksPort,
                        socks: true
                    });
                }

                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${this.sshDest.hostname}`
                    }
                });

                return new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                if (!(e instanceof Error)) {
                    throw e;
                }

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${this.sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
            }
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort);
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.sshConnection?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    private async gatherIdentityFiles() {
        const identityFiles = new Set<string>();
        const sshconfig = await SSHConfiguration.loadFromFS();
        this.sshHostConfig = sshconfig.getHostConfiguration(this.sshDest.hostname);
        for (const i of ((this.sshHostConfig['IdentityFile'] as any as string[]) || [])) {
            if (await fileExists(i)) {
                identityFiles.add(untildify(i));
            }
        }

        const defaultIdentityFiles = await checkDefaultIdentityFiles();
        defaultIdentityFiles.forEach(i => identityFiles.add(untildify(i)));

        const result = [...identityFiles.keys()];

        this.logger.info(`Found Identity files:`, result);

        return result;
    }

    private async sshAuthHandler(methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) {
        if (methodsLeft === null) {
            this.logger.info(`Trying no-auth authentication`);

            return callback({
                type: 'none',
                username: this.sshDest.user || '',
            });
        }
        if (methodsLeft.includes('publickey') && this.identityFiles.length) {
            this.logger.info(`Trying publickey authentication: ${this.identityFiles[0]}`);

            const identityFile = this.identityFiles.shift()!;
            const keyBuffer = await fs.promises.readFile(identityFile);

            // First try without passphrase
            let result = ssh2.utils.parseKey(keyBuffer);
            if (result instanceof Error && result.message === 'Encrypted private OpenSSH key detected, but no passphrase given') {
                let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                while (result instanceof Error && passphraseRetryCount > 0) {
                    const passphrase = await vscode.window.showInputBox({
                        title: `Enter passphrase for ${identityFile}`,
                        password: true,
                        ignoreFocusOut: true
                    });

                    if (!passphrase) {
                        break;
                    }

                    result = ssh2.utils.parseKey(keyBuffer, passphrase);
                    passphraseRetryCount--;
                }
            }
            if (!result || result instanceof Error) {
                // Try next identity file
                return callback(null as any);
            }

            const key = Array.isArray(result) ? result[0] : result;

            return callback({
                type: 'publickey',
                username: this.sshDest.user || '',
                key
            });
        }
        if (methodsLeft.includes('password') && this.passwordRetryCount > 0) {
            if (this.passwordRetryCount === PASSWORD_RETRY_COUNT) {
                this.logger.info(`Trying password authentication`);
            }

            const password = await vscode.window.showInputBox({
                title: `Enter password for ${this.sshDest.user}@${this.sshDest.hostname}`,
                password: true,
                ignoreFocusOut: true
            });
            this.passwordRetryCount--;

            return callback(password
                ? {
                    type: 'password',
                    username: this.sshDest.user || '',
                    password
                }
                : false);
        }

        callback(false);
    }

    dispose() {
        disposeAll(this.tunnels);
        this.sshConnection?.close();
        this.labelFormatterDisposable?.dispose();
    }
}
