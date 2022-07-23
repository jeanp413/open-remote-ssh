import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await vscode.window.showInputBox({
        title: 'Enter [user@]hostname[:port]'
    });

    if (!host) {
        return;
    }

    openRemoteSSHWindow(host, reuseWindow);
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}
