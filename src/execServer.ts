import * as vscode from 'vscode';
import type { ClientChannel, SFTPWrapper } from 'ssh2';
import type { Stats, FileEntry } from 'ssh2-streams';
import SSHConnection from './ssh/sshConnection';
import Log from './common/logger';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// TODO: probs a can of worms, clean up
function shellEscape(arg: string): string {
	if (/^[a-zA-Z0-9._\-/=:@,+]+$/.test(arg)) {return arg;}
	return '\'' + arg.replace(/'/g, '\'\\\'\'') + '\'';
}

function buildCommand(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): string {
	let cmd = '';
	if (options?.cwd) {
		cmd += `cd ${shellEscape(options.cwd)} && `;
	}
	if (options?.env) {
		for (const [key, value] of Object.entries(options.env)) {
			cmd += `${key}=${shellEscape(value)} `;
		}
	}
	cmd += shellEscape(command);
	for (const arg of args) {
		cmd += ' ' + shellEscape(arg);
	}
	return cmd;
}

function nodeReadableToReadStream(readable: NodeJS.ReadableStream): vscode.ReadStream {
	const emitter = new vscode.EventEmitter<Uint8Array>();
	const onEnd = new Promise<void>((resolve) => {
		readable.on('data', (chunk: Buffer) => emitter.fire(new Uint8Array(chunk)));
		readable.on('end', () => { resolve(); emitter.dispose(); });
		readable.on('error', () => { resolve(); emitter.dispose(); });
	});
	return { onDidReceiveMessage: emitter.event, onEnd };
}

function wrapDuplexChannel(channel: ClientChannel): { stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> } {
	const emitter = new vscode.EventEmitter<Uint8Array>();
	let resolved = false;
	const done = new Promise<void>((resolve) => {
		const finish = () => { if (!resolved) { resolved = true; resolve(); emitter.dispose(); } };
		channel.on('end', finish);
		channel.on('close', finish);
		channel.on('error', finish);
	});
	channel.on('data', (chunk: Buffer) => emitter.fire(new Uint8Array(chunk)));
	return {
		stream: {
			onDidReceiveMessage: emitter.event,
			onEnd: done,
			write(data: Uint8Array) { channel.write(Buffer.from(data)); },
			end() { channel.end(); }
		},
		done
	};
}

function fileTypeFromMode(mode: number): vscode.FileType {
	const fmt = mode & S_IFMT;
	if (fmt === S_IFDIR) {return vscode.FileType.Directory;}
	if (fmt === S_IFLNK) {return vscode.FileType.SymbolicLink;}
	return vscode.FileType.File;
}

export function createExecServer(conn: SSHConnection, logger: Log): vscode.ExecServer {
	let sftpClient: SFTPWrapper | undefined;

	async function getSftp(): Promise<SFTPWrapper> {
		if (sftpClient) {return sftpClient;}
		const client = conn.getClient();
		if (!client) {throw new Error('SSH connection not available');}
		return new Promise((resolve, reject) => {
			client.sftp((err, sftp) => {
				if (err) {return reject(err);}
				sftpClient = sftp;
				resolve(sftp);
			});
		});
	}

	return {
		async spawn(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Promise<vscode.SpawnedCommand> {
			const cmd = buildCommand(command, args, options);
			logger.trace(`ExecServer.spawn: ${cmd}`);
			const channel = await conn.execChannel(cmd);

			return {
				stdin: {
					write(data: Uint8Array) { channel.write(Buffer.from(data)); },
					end() { channel.end(); }
				},
				stdout: nodeReadableToReadStream(channel),
				stderr: nodeReadableToReadStream(channel.stderr),
				onExit: new Promise<vscode.ProcessExit>((resolve) => {
					let done = false;
					channel.on('exit', (code: number | null, signal?: string) => {
						if (!done) { done = true; resolve({ status: code ?? (signal ? 128 : 0) }); }
					});
					channel.on('close', () => {
						if (!done) { done = true; resolve({ status: 1 }); }
					});
				})
			};
		},

		async env(): Promise<vscode.ExecEnvironment> {
			const { stdout: envOut } = await conn.exec('env -0 2>/dev/null || env');
			const env: Record<string, string> = {};
			const separator = envOut.includes('\0') ? '\0' : '\n';
			for (const entry of envOut.split(separator)) {
				const eqIdx = entry.indexOf('=');
				if (eqIdx > 0) {
					env[entry.substring(0, eqIdx)] = entry.substring(eqIdx + 1);
				}
			}

			const { stdout: unameOut } = await conn.exec('uname -s');
			const kernel = unameOut.trim();
			const osPlatform = kernel === 'Darwin' ? 'darwin'
				: (kernel.startsWith('MINGW') || kernel.startsWith('MSYS')) ? 'win32'
				: 'linux';

			let osRelease: string | undefined;
			try {
				const { stdout: releaseOut } = await conn.exec('uname -r');
				osRelease = releaseOut.trim() || undefined;
			} catch { /* ignore */ }

			return { env, osPlatform, osRelease };
		},

		async kill(processId: number): Promise<void> {
			logger.trace(`ExecServer.kill: ${processId}`);
			await conn.exec(`kill ${processId}`);
		},

		async tcpConnect(host: string, port: number): Promise<{ stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> }> {
			logger.trace(`ExecServer.tcpConnect: ${host}:${port}`);
			const channel = await conn.forwardOut('127.0.0.1', 0, host, port);
			return wrapDuplexChannel(channel);
		},

		fs: {
			async stat(remotePath: string): Promise<vscode.FileStat> {
				const sftp = await getSftp();
				return new Promise((resolve, reject) => {
					sftp.lstat(remotePath, (err: any, stats: Stats) => {
						if (err) {return reject(err);}
						resolve({
							type: stats.isDirectory() ? vscode.FileType.Directory
								: stats.isSymbolicLink() ? vscode.FileType.SymbolicLink
								: vscode.FileType.File,
							ctime: (stats.atime ?? stats.mtime ?? 0) * 1000,
							mtime: (stats.mtime ?? 0) * 1000,
							size: stats.size ?? 0
						});
					});
				});
			},

			async mkdirp(remotePath: string): Promise<void> {
				const sftp = await getSftp();
				const segments: string[] = [];
				let dir = remotePath;
				// Walk up until we find a directory that exists
				for (;;) {
					const exists = await new Promise<boolean>((resolve) => {
						sftp.stat(dir, (err) => resolve(!err));
					});
					if (exists) {break;}
					segments.push(dir);
					const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
					if (parent === dir) {break;}
					dir = parent;
				}
				// Create directories top-down
				for (let i = segments.length - 1; i >= 0; i--) {
					await new Promise<void>((resolve, reject) => {
						sftp.mkdir(segments[i], (err) => {
							if (err) {reject(err);}
							else {resolve();}
						});
					});
				}
			},

			async rm(remotePath: string): Promise<void> {
				const sftp = await getSftp();
				async function rmRecursive(p: string): Promise<void> {
					const stats = await new Promise<Stats>((resolve, reject) => {
						sftp.lstat(p, (err, s) => err ? reject(err) : resolve(s));
					});
					if (stats.isDirectory()) {
						const entries = await new Promise<FileEntry[]>((resolve, reject) => {
							sftp.readdir(p, (err, list) => err ? reject(err) : resolve(list));
						});
						for (const entry of entries) {
							await rmRecursive(p + '/' + entry.filename);
						}
						await new Promise<void>((resolve, reject) => {
							sftp.rmdir(p, (err) => err ? reject(err) : resolve());
						});
					} else {
						await new Promise<void>((resolve, reject) => {
							sftp.unlink(p, (err) => err ? reject(err) : resolve());
						});
					}
				}
				try {
					await rmRecursive(remotePath);
				} catch (err: any) {
					if (err?.code === 2) {return;} // ENOENT — already gone
					throw err;
				}
			},

			async read(remotePath: string): Promise<vscode.ReadStream> {
				const sftp = await getSftp();
				const readable = sftp.createReadStream(remotePath);
				return nodeReadableToReadStream(readable);
			},

			async write(remotePath: string): Promise<{ stream: vscode.WriteStream; done: Thenable<void> }> {
				const sftp = await getSftp();
				const writable = sftp.createWriteStream(remotePath);
				const writeDone = new Promise<void>((resolve, reject) => {
					writable.on('close', resolve);
					writable.on('error', reject);
				});
				return {
					stream: {
						write(data: Uint8Array) { writable.write(Buffer.from(data)); },
						end() { writable.end(); }
					},
					done: writeDone
				};
			},

			async connect(socketPath: string): Promise<{ stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> }> {
				const client = conn.getClient();
				if (!client) {throw new Error('SSH connection not available');}
				const channel = await new Promise<ClientChannel>((resolve, reject) => {
					client.openssh_forwardOutStreamLocal(socketPath, (err, stream) => {
						if (err) {reject(err);}
						else {resolve(stream);}
					});
				});
				return wrapDuplexChannel(channel);
			},

			async rename(fromPath: string, toPath: string): Promise<void> {
				const sftp = await getSftp();
				return new Promise((resolve, reject) => {
					sftp.rename(fromPath, toPath, (err: any) => {
						if (err) {return reject(err);}
						resolve();
					});
				});
			},

			async readdir(remotePath: string): Promise<vscode.DirectoryEntry[]> {
				const sftp = await getSftp();
				return new Promise((resolve, reject) => {
					sftp.readdir(remotePath, (err: any, list: FileEntry[]) => {
						if (err) {return reject(err);}
						resolve(list.map(item => ({
							name: item.filename,
							type: fileTypeFromMode(item.attrs.mode)
						})));
					});
				});
			}
		}
	};
}
