import * as fs from 'fs';
import * as net from 'net';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import { ParsedKey } from 'ssh2-streams';
import * as crypto from 'crypto';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { DEFAULT_IDENTITY_FILES } from './ssh/identityFiles';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer } from './serverSetup';
import { isWindows } from './common/platform';

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

interface SSHKey {
    filename: string;
    parsedKey: ParsedKey;
    fingerprint: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private sshConnection: SSHConnection | undefined;
    private sshHostConfig!: Record<string, string>;
    private identityKeys!: SSHKey[];
    private sshAgentSock: string | undefined;
    private sshHostName: string | undefined;
    private sshUser: string | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];

    private passwordRetryCount: number = PASSWORD_RETRY_COUNT;

    private labelFormatterDisposable: vscode.Disposable | undefined;

    constructor(readonly logger: Log) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attemp #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parse(dest);
        this.passwordRetryCount = PASSWORD_RETRY_COUNT;

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate', 'https://github.com/VSCodium/vscodium/releases/download/${version}/vscodium-reh-linux-${arch}-${version}.tar.gz')!;
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                this.sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                this.sshHostName = this.sshHostConfig['HostName'] || sshDest.hostname;
                this.sshUser = this.sshHostConfig['User'] || sshDest.user;
                this.sshAgentSock = isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : (this.sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK']);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const sshPort = this.sshHostConfig['Port'] ? parseInt(this.sshHostConfig['Port'], 10) : undefined;

                this.identityKeys = await this.gatherIdentityFiles();

                this.sshConnection = new SSHConnection({
                    host: this.sshHostName,
                    username: this.sshUser,
                    port: sshPort,
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
                        workspaceSuffix: `SSH: ${sshDest.hostname}`
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
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
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

    // From https://github.com/openssh/openssh-portable/blob/acb2059febaddd71ee06c2ebf63dcf211d9ab9f2/sshconnect2.c#L1689-L1690
    private async gatherIdentityFiles() {
        const identityFiles: string[] = ((this.sshHostConfig['IdentityFile'] as unknown as string[]) || []).map(untildify);
        if (identityFiles.length === 0) {
            identityFiles.push(...DEFAULT_IDENTITY_FILES);
        }

        const identityFileContentsResult = await Promise.allSettled(identityFiles.map(async path => fs.promises.readFile(path + '.pub')));
        const fileKeys: SSHKey[] = identityFileContentsResult.map((result, i) => {
            if (result.status === 'rejected') {
                return undefined;
            }

            const parsedResult = ssh2.utils.parseKey(result.value);
            if (parsedResult instanceof Error || !parsedResult) {
                this.logger.error(`Error while parsing SSH public key ${identityFiles[i] + '.pub'}:`, parsedResult);
                return undefined;
            }

            const parsedKey = Array.isArray(parsedResult) ? parsedResult[0] : parsedResult;
            const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');

            return {
                filename: identityFiles[i],
                parsedKey,
                fingerprint
            };
        }).filter(<T>(v: T | undefined): v is T => !!v);

        let sshAgentParsedKeys: ParsedKey[] = [];
        try {
            if (!this.sshAgentSock) {
                throw new Error(`SSH_AUTH_SOCK environment variable not defined`);
            }

            sshAgentParsedKeys = await new Promise<ParsedKey[]>((resolve, reject) => {
                const sshAgent = new ssh2.OpenSSHAgent(this.sshAgentSock!);
                sshAgent.getIdentities((err, publicKeys) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(publicKeys || []);
                    }
                });
            });
        } catch (e) {
            this.logger.error(`Couldn't get identities from OpenSSH agent`, e);
        }

        const sshAgentKeys: SSHKey[] = sshAgentParsedKeys.map(parsedKey => {
            const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
            return {
                filename: parsedKey.comment,
                parsedKey,
                fingerprint,
                agentSupport: true
            };
        });

        const identitiesOnly = (this.sshHostConfig['IdentitiesOnly'] || '').toLowerCase() === 'yes';
        const agentKeys: SSHKey[] = [];
        const preferredIdentityKeys: SSHKey[] = [];
        for (const agentKey of sshAgentKeys) {
            const foundIdx = fileKeys.findIndex(k => agentKey.parsedKey.type === k.parsedKey.type && agentKey.fingerprint === k.fingerprint);
            if (foundIdx >= 0) {
                preferredIdentityKeys.push({ ...fileKeys[foundIdx], agentSupport: true });
                fileKeys.splice(foundIdx, 1);
            } else if (!identitiesOnly) {
                agentKeys.push(agentKey);
            }
        }
        preferredIdentityKeys.push(...agentKeys);
        preferredIdentityKeys.push(...fileKeys);

        this.logger.trace(`Identity keys:`, preferredIdentityKeys.length ? preferredIdentityKeys.map(k => `${k.filename} ${k.parsedKey.type} SHA256:${k.fingerprint}`).join('\n') : 'None');

        return preferredIdentityKeys;
    }

    private async sshAuthHandler(methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) {
        if (methodsLeft === null) {
            this.logger.info(`Trying no-auth authentication`);

            return callback({
                type: 'none',
                username: this.sshUser || '',
            });
        }
        if (methodsLeft.includes('publickey') && this.identityKeys.length) {
            const identityKey = this.identityKeys.shift()!;

            this.logger.info(`Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`);

            if (identityKey.agentSupport) {
                return callback({
                    type: 'agent',
                    username: this.sshUser || '',
                    agent: new class extends ssh2.OpenSSHAgent {
                        // Only return the current key
                        override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                            callback(undefined, [identityKey.parsedKey]);
                        }
                    }(this.sshAgentSock!)
                });
            }
            if (identityKey.isPrivate) {
                return callback({
                    type: 'publickey',
                    username: this.sshUser || '',
                    key: identityKey.parsedKey
                });
            }
            if (!await fileExists(identityKey.filename)) {
                // Try next identity file
                return callback(null as any);
            }

            const keyBuffer = await fs.promises.readFile(identityKey.filename);
            let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
            if (result instanceof Error && result.message === 'Encrypted private OpenSSH key detected, but no passphrase given') {
                let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                while (result instanceof Error && passphraseRetryCount > 0) {
                    const passphrase = await vscode.window.showInputBox({
                        title: `Enter passphrase for ${identityKey}`,
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
                username: this.sshUser || '',
                key
            });
        }
        if (methodsLeft.includes('password') && this.passwordRetryCount > 0) {
            if (this.passwordRetryCount === PASSWORD_RETRY_COUNT) {
                this.logger.info(`Trying password authentication`);
            }

            const password = await vscode.window.showInputBox({
                title: `Enter password for ${this.sshUser}@${this.sshHostName}`,
                password: true,
                ignoreFocusOut: true
            });
            this.passwordRetryCount--;

            return callback(password
                ? {
                    type: 'password',
                    username: this.sshUser || '',
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
