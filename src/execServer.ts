import * as vscode from 'vscode';
import path from 'node:path';
import Stream from 'node:stream';

import { SFTPWrapper, ExecOptions, ClientChannel } from 'ssh2';
import { FileEntry, Stats } from 'ssh2-streams';

import SSHConnection from './ssh/sshConnection';
import { Log } from './common/logger';

let CMD_INX = 0;

type ReadWriteStream = vscode.ReadStream & vscode.WriteStream;

export function shellEscapeArg(arg: string) {
    // eslint-disable-next-line @stylistic/quotes
    return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function formatError(err: Error) {
    return `name=${err.name}, message=${err.message}, stack=${err.stack}`;
}

export function shellEscaped(cmd: string, args: string[], options?: vscode.ExecServerSpawnOptions): string {
    const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z_0-9]*$/;

    let stringCmd = [cmd, ...args].map(e => shellEscapeArg(e)).join(' ');
    if (options?.env) {
        const envStr = Object.entries(options.env)
            .map(([k, v]) => {
                if (ENV_KEY_REGEX.test(k) ===  false) {
                    throw new Error(`Bad env key: '${k}'`);
                }
                return `${k}=${shellEscapeArg(v)}`;
            })
            .join(' ');

        stringCmd = `${envStr} ${stringCmd}`;
    }

    // must be after adding env
    if (options?.cwd) {
        stringCmd = `cd ${shellEscapeArg(options.cwd)} && ${stringCmd}`;
    }

    return stringCmd;
}

function toReadStream(stream: Stream.Readable, logger: Log): vscode.ReadStream {
    const emitter = new vscode.EventEmitter<Uint8Array>();

    stream.on('data', (str: Buffer) => { emitter.fire(str); });

    return {
        onDidReceiveMessage: emitter.event,
        onEnd: new Promise<void>((resolve, reject) => {
            stream.on('end', () => {
                resolve();
                emitter.dispose();
            });
            stream.on('error', (err: Error) => {
                logger.error(`toReadStream error: ${formatError(err)}`);
                emitter.dispose();
                reject(err);
            });
        }),
    };
}

function toReadWriteStream(stream: Stream.Duplex, logger: Log): ReadWriteStream {
    const emitter = new vscode.EventEmitter<Uint8Array>();

    stream.on('data', (str: Buffer) => { emitter.fire(str); });

    return {
        onDidReceiveMessage: emitter.event,
        onEnd: new Promise<void>((resolve, reject) => {
            stream.on('end', () => {
                resolve();
                emitter.dispose();
            });
            stream.on('error', (err: Error) => {
                logger.error(`toReadWriteStream error: ${formatError(err)}`);
                emitter.dispose();
                reject(err);
            });
        }),
        write(data: Uint8Array) { stream.write(data); },
        end() { stream.end(); }
    };
}

function getFileType(mode: number) {
    const S_IFMT = 0o0170000;  // bit mask for the file type bit field
    enum modes {
        S_IFDIR = 0o0040000, // directory
        S_IFREG = 0o0100000, // regular file
        S_IFLNK = 0o0120000, // symbolic link
    }
    const ftype = mode & S_IFMT;
    if ((ftype & modes.S_IFDIR) === modes.S_IFDIR) { return vscode.FileType.Directory; }
    else if ((ftype & modes.S_IFLNK) === modes.S_IFLNK) { return vscode.FileType.SymbolicLink; }
    else if ((ftype & modes.S_IFREG) === modes.S_IFREG) { return vscode.FileType.File; }
    else { return vscode.FileType.Unknown; }
}

export class SSHExecServerFileSystem implements vscode.RemoteFileSystem, vscode.Disposable {
    public constructor(
        private readonly conn: SSHConnection,
        private readonly sftp: SFTPWrapper,
        private readonly logger: Log
    ) {
    }

    public stat(path: string): Promise<vscode.FileStat> {
        return new Promise((resolve, reject) => {
            this.sftp.lstat(path, (err: Error, stats: Stats) => {
                if (err) {
                    this.logger.error(`SFTP: stat('${path}'): ${formatError(err)}`);
                    reject(err);
                }
                else {
                    const ret: vscode.FileStat = {
                        type: stats.isDirectory() ? vscode.FileType.Directory
                            : stats.isSymbolicLink() ? vscode.FileType.SymbolicLink
                                : stats.isFile() ? vscode.FileType.File : vscode.FileType.Unknown,
                        ctime: stats.mtime * 1000, // no ctime in stats
                        mtime: stats.mtime * 1000,
                        size: stats.size,
                        permissions: ((stats.mode & 0o222) === 0) ? vscode.FilePermission.Readonly : undefined,
                    };
                    this.logger.info(`SFTP: stat('${path}'): ${JSON.stringify(ret)}`);
                    resolve(ret);
                }
            });
        });
    }

    public async mkdirp(dirPath: string): Promise<void> {
        this.logger.info(`SFTP: mkdirp('${dirPath}')`);
        const segments: string[] = [];
        let dir = dirPath;

        try {
            while (true) {
                try {
                    await this.stat(dir);
                    break;
                }
                catch { /* dir doesn't exist */ }

                segments.push(dir);
                const parent = path.posix.dirname(dir);

                if (parent === dir) { break; }
                dir = parent;
            }

            for (const segment of segments.reverse()) {
                await new Promise<void>((resolve, reject) => {
                    this.sftp.mkdir(segment, (err) => {
                        if (err) {reject(err);}
                        else {resolve();}
                    });
                });
            }
        }
        catch (err: unknown) {
            if (err instanceof Error) {
                this.logger.error(`SFTP: mkdirp('${dirPath}') failed: ${formatError(err as Error)}`);
            }
            throw err;
        }
    }

    public rm(path: string): Promise<void> {
        this.logger.info(`SFTP: rm('${path}')`);
        throw new Error('Method "rm" not implemented.');
    }

    public async read(path: string): Promise<vscode.ReadStream> {
        this.logger.info(`SFTP: read('${path}')`);
        return toReadStream(this.sftp.createReadStream(path), this.logger);
    }

    public async write(path: string): Promise<{ stream: vscode.WriteStream; done: Promise<void> }> {
        this.logger.info(`SFTP: write('${path}')`);
        const writeStream = this.sftp.createWriteStream(path);

        return {
            stream: {
                write: (data: Uint8Array) => { writeStream.write(data); },
                end: () => { writeStream.end(); },
            },
            done: new Promise<void>((resolve, reject) => {
                writeStream.on('close', () => { resolve(); });
                writeStream.on('error', (err: Error) => { reject(err); });
            })
        };
    }

    public connect(sockPath: string): Promise<{ stream: vscode.WriteStream & vscode.ReadStream; done: Promise<void> }> {
        this.logger.info(`SFTP: connect('${sockPath}')`);

        return new Promise((resolve, reject) => {
            this.conn.getClient().openssh_forwardOutStreamLocal(sockPath, (err: Error | undefined, chan: ClientChannel) => {
                if (err) {return reject(err);}

                resolve({
                    stream: toReadWriteStream(chan, this.logger),
                    done: new Promise((res, rej) => {
                        chan.on('close', () => res());
                        chan.on('exit', (exitCode: number | null, signalName?: string, didCoreDump?: boolean, description?: string) => {
                            if (exitCode === 0) return res();

                            void(didCoreDump);
                            this.logger.error(`SFTP.connect: error: exitCode=${exitCode}, signalName=${signalName}, description=${description}`);
                            rej({ status: exitCode ?? (signalName ? 128 : 0) });
                        });
                    }),
                });
            });
        });
    }

    public rename(fromPath: string, toPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.sftp.rename(fromPath, toPath, (err: Error) => {
                if (err) {
                    this.logger.error(`SFTP: rename(fromPath: '${fromPath}', toPath: '${toPath}'): ${formatError(err)}`);
                    reject(err);
                }
                else {
                    this.logger.info(`SFTP: rename(fromPath: '${fromPath}', toPath: '${toPath}'): OK`);
                    resolve();
                }
            });
        });
    }

    public readdir(path: string): Promise<vscode.DirectoryEntry[]> {
        return new Promise((resolve, reject) => {
            this.sftp.readdir(path, (err: Error, fileList: FileEntry[]) => {
                if (err) {
                    this.logger.error(`SFTP: readdir('${path}'): ${formatError(err)}`);
                    reject(err);
                }
                else {
                    this.logger.info(`SFTP: readdir('${path}'): ${JSON.stringify(fileList)}`);
                    const ret: vscode.DirectoryEntry[] = fileList.map(e => {
                        return {
                            type: getFileType(e.attrs.mode),
                            name: e.filename,
                        };
                    });
                    resolve(ret);
                }
            });
        });
    }

    public dispose() {
        this.sftp.end();
    }
}

export class SSHExecServer implements vscode.ExecServer, vscode.Disposable {
    private constructor(
        private readonly conn: SSHConnection,
        public readonly fs: SSHExecServerFileSystem,
        private readonly logger: Log,
    ) {
    }

    private exec(cmd: string, args: string[], opts?: ExecOptions): Promise<{ stdout: string; stderr: string }> {
        this.logger.info(`SSHExecServer.exec(cmd: ${cmd}, args: [${args.join(', ')}], opts: ${JSON.stringify(opts)})`);
        return this.conn.exec(cmd, args, opts);
    }

    public static async create(conn: SSHConnection, logger: Log) {
        logger.info('creating SSHExecServer...');
        const sftp = await conn.createSftp();
        const fs = new SSHExecServerFileSystem(conn, sftp, logger);
        return new SSHExecServer(conn, fs, logger);
    }

    public async spawn(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Promise<vscode.SpawnedCommand> {
        const cmdInx = ++CMD_INX;
        const cmd = shellEscaped(command, args, options);
        this.logger.info(`SSHExecServer.spawn [${cmdInx}]: [${command}, ${args.join(', ')}] => '${cmd}'`);
        const channel = await this.conn.execChannel(cmd, {});

        return {
            stdin: {
                write(data: Uint8Array) { channel.stdin.write(data); },
                end() { channel.stdin.end(); }
            },
            stdout: toReadStream(channel.stdout, this.logger),
            stderr: toReadStream(channel.stderr, this.logger),
            onExit: new Promise((resolve) => {
                let cmdExit = false;
                channel.on('exit', (exitCode: number | null, signalName?: string, _didCoreDump?: boolean, description?: string) => {
                    cmdExit = true;
                    if (exitCode === 0) {
                        this.logger.info(`SSHExecServer.spawn [${cmdInx}]: OK: ${cmd}`);
                        resolve({ status: 0 });
                    }
                    else {
                        this.logger.error(`SSHExecServer.spawn [${cmdInx}]: error: exitCode=${exitCode}, signalName=${signalName}, description=${description}`);
                        resolve({ status: exitCode ?? (signalName ? 128 : 0) });
                    }
                });
                channel.on('close', () => {
                    if (!cmdExit) {
                        this.logger.error(`SSHExecServer.spawn [${cmdInx}]: channel "${cmd}" was closed`);
                        resolve({ status: 1 });
                    }
                });
            }),
        };
    }

    public async env(): Promise<vscode.ExecEnvironment> {
        // TODO: mac and windows support
        this.logger.info('SSHExecServer.env()');
        try {
            const envs: Record<string, string> = {};
            let osPlatform: string | undefined;
            let osVer: string | undefined;

            {
                const { stdout: envStdout, stderr: envStderr } = await this.exec('env', ['-0']);

                if (envStderr) { this.logger.error(`Remote env probe stderr: '${envStderr}'`); }

                for (const entry of envStdout.split('\0')) {
                    // .trim does not trim '\0'
                    if (!entry) { continue; }
                    const eqInx = entry.indexOf('=');

                    // shouldn't happen
                    if (eqInx <= 0) { continue; }

                    const [k, v] = [entry.slice(0, eqInx), entry.slice(eqInx + 1)];
                    envs[k] = v;
                }
            }

            {
                const { stdout: unameSysStdout, stderr: unameSysStderr } = await this.exec('uname', ['-s']);
                const plat = unameSysStdout.trim().toLowerCase();
                if (plat === 'linux' || plat === 'darwin') {
                    osPlatform = plat;
                }
                else {
                    throw new Error(`Unsupported platform ${plat}`);
                }

                if (unameSysStderr) { this.logger.error(`Remote 'uname -s' probe stderr: '${unameSysStderr}'`); }
            }

            {
                const { stdout: unameVerStdout, stderr: unameVerStderr } = await this.exec('uname', ['-r']);
                const ver = unameVerStdout.trim().toLowerCase();
                osVer = ver;

                if (unameVerStderr) { this.logger.error(`Remote 'uname -r' probe stderr: '${unameVerStderr}'`); }
            }

            return { env: envs, osPlatform: osPlatform, osRelease: osVer };
        }
        catch (ex: unknown) {
            if (ex instanceof Error) {
                const err = `SSHExecServer.env(): Could not query remote env. Is remote windows? ${formatError(ex as Error)}`;
                this.logger.error(err);
            }
            throw ex;
        }
    }

    public async kill(processId: number): Promise<void> {
        await this.exec('kill', [`${processId}`]);
        return;
    }

    public async tcpConnect(host: string, port: number): Promise<{ stream: ReadWriteStream; done: Promise<void> }> {
        this.logger.info(`SSHExecServer.tcpConnect(host: ${host}, port: ${port})`);
        const chan = await this.conn.forwardOut('127.0.0.1', 0, host, port);
        return {
            stream: toReadWriteStream(chan, this.logger),
            done: new Promise((resolve, reject) => {
                chan.on('close', () => resolve());
                chan.on('exit', (exitCode: number | null, signalName?: string, didCoreDump?: boolean, description?: string) => {
                    if (exitCode === 0) return resolve();

                    void(didCoreDump);
                    this.logger.error(`SSHExecServer.tcpConnect: error: exitCode=${exitCode}, signalName=${signalName}, description=${description}`);
                    reject({ status: exitCode ?? (signalName ? 128 : 0) });
                });
            }),
        };
    }

    public dispose() {
        this.fs.dispose();
        // conn is closed in the resolver
    }
}
