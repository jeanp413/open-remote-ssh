import * as vscode from 'vscode';

export class SSHExecServer implements vscode.ExecServer, vscode.Disposable {
    fs: vscode.RemoteFileSystem;

    public constructor() { }

    public spawn(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.SpawnedCommand> {
        throw new Error('Method not implemented.');
    }

    public spawnRemoteServerConnector?(command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.RemoteServerConnector> {
        throw new Error('Method not implemented.');
    }

    public downloadCliExecutable?(buildTarget: vscode.CliBuild, command: string, args: string[], options?: vscode.ExecServerSpawnOptions): Thenable<vscode.ProcessExit> {
        throw new Error('Method not implemented.');
    }

    public env(): Thenable<vscode.ExecEnvironment> {
        throw new Error('Method not implemented.');
    }

    public kill(processId: number): Thenable<void> {
        throw new Error('Method not implemented.');
    }

    public tcpConnect(host: string, port: number): Thenable<{ stream: vscode.WriteStream & vscode.ReadStream; done: Thenable<void> }> {
        throw new Error('Method not implemented.');
    }

    public dispose() {
        throw new Error('Method not implemented.');
    }
}
