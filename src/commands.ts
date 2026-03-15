import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import SSHConfiguration, { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';

const ENTER_HOST_MANUALLY_LABEL = 'Enter host manually...';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const sshConfig = await SSHConfiguration.loadFromFS();
    const hosts = sshConfig.getAllConfiguredHosts();

    if (hosts.length === 0) {
        // No configured hosts, fall back to input box
        return promptManualHostEntry(reuseWindow);
    }

    const hostItems: vscode.QuickPickItem[] = hosts.map(host => {
        const config = sshConfig.getHostConfiguration(host);
        const hostName = config['HostName'];
        const user = config['User'];
        const port = config['Port'];
        const details: string[] = [];
        if (hostName && hostName !== host) {
            details.push(hostName);
        }
        if (user) {
            details.push(`user: ${user}`);
        }
        if (port && port !== '22') {
            details.push(`port: ${port}`);
        }
        return {
            label: host,
            description: details.join('  ·  '),
            iconPath: new vscode.ThemeIcon('vm'),
        };
    });

    const items: vscode.QuickPickItem[] = [
        ...hostItems,
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: ENTER_HOST_MANUALLY_LABEL, iconPath: new vscode.ThemeIcon('terminal') },
    ];

    const selected = await vscode.window.showQuickPick(items, {
        title: 'Select an SSH host to connect to',
        placeHolder: 'Choose a configured host or enter one manually',
    });

    if (!selected) {
        return;
    }

    if (selected.label === ENTER_HOST_MANUALLY_LABEL) {
        return promptManualHostEntry(reuseWindow);
    }

    const sshDest = new SSHDestination(selected.label);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

async function promptManualHostEntry(reuseWindow: boolean) {
    const host = await vscode.window.showInputBox({
        title: 'Enter [user@]hostname[:port]',
        placeHolder: 'e.g. user@example.com',
    });

    if (!host) {
        return;
    }

    const sshDest = new SSHDestination(host);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function addNewHost() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath), { preview: false });

    const textEditor = vscode.window.activeTextEditor;
    if (textEditor?.document.uri.fsPath !== sshConfigPath) {
        return;
    }

    const textDocument = textEditor.document;
    const lastLine = textDocument.lineAt(textDocument.lineCount - 1);

    if (!lastLine.isEmptyOrWhitespace) {
        await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.insert(lastLine.range.end, '\n');
        });
    }

    let snippet = '\nHost ${1:dev}\n\tHostName ${2:dev.example.com}\n\tUser ${3:john}';
    await textEditor.insertSnippet(
        new vscode.SnippetString(snippet),
        new vscode.Position(textDocument.lineCount, 0)
    );
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}
