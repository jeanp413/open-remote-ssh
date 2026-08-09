import * as vscode from 'vscode';
import { Log } from './common/logger';
import { SFTPWrapper } from 'ssh2';
import SSHConnection from './ssh/sshConnection';

export class SSHExecServerFileSystem implements vscode.RemoteFileSystem, vscode.Disposable {
    public constructor(
        private readonly sftp: SFTPWrapper,
        private readonly logger: Log
    ) {
    }

    public stat(path: string): Thenable<vscode.FileStat> {
        throw new Error("Method 'stat' not implemented.");
    }

    public mkdirp(path: string): Thenable<void> {
        throw new Error("Method 'mkdirp' not implemented.");
    }

    public rm(path: string): Thenable<void> {
        throw new Error("Method 'rm' not implemented.");
    }

    public read(path: string): Thenable<vscode.ReadStream> {
        throw new Error("Method 'read' not implemented.");
    }

    public write(path: string): Thenable<{ stream: vscode.WriteStream; done: Thenable<void>; }> {
        throw new Error("Method 'write' not implemented.");
    }

    public connect(path: string): Thenable<{ stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void>; }> {
        throw new Error("Method 'connect' not implemented.");
    }

    public rename(fromPath: string, toPath: string): Thenable<void> {
        throw new Error("Method 'rename' not implemented.");
    }

    public readdir(path: string): Thenable<vscode.DirectoryEntry[]> {
        throw new Error("Method 'readdir' not implemented.");
    }

    public dispose() {
        throw new Error("Method 'dispose' not implemented.");
    }
}

export class SSHExecServer implements vscode.ExecServer, vscode.Disposable {
    fs: SSHExecServerFileSystem;

    public constructor(
        private readonly conn: SSHConnection,
        private readonly logger: Log
    ) {
        this.fs = new SSHExecServerFileSystem(conn, logger);
    }

    public spawn(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.SpawnedCommand> {
        throw new Error("Method not implemented.");
    }

    public spawnRemoteServerConnector?(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.RemoteServerConnector> {
        throw new Error("Method not implemented.");
    }

    public downloadCliExecutable?(buildTarget: vscode.CliBuild, command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.ProcessExit> {
        throw new Error("Method not implemented.");
    }

    public env(): Thenable<vscode.ExecEnvironment> {
        throw new Error("Method not implemented.");
    }

    public kill(processId: number): Thenable<void> {
        throw new Error("Method not implemented.");
    }

    public tcpConnect(host: string, port: number): Thenable<{ stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> }> {
        throw new Error("Method not implemented.");
    }

    public dispose() {
        throw new Error("Method not implemented.");
    }
}
