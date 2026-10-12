import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import SSHConfiguration, { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await promptForHost();

    if (!host) {
        return;
    }

    const sshDest = new SSHDestination(host);
    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

/**
 * Lists the hosts from the SSH config while still accepting an arbitrary
 * [user@]hostname[:port]. Whatever is typed is offered as the first item, so
 * typing a host and pressing enter keeps working exactly as it did before.
 */
async function promptForHost(): Promise<string | undefined> {
    let configuredHosts: string[] = [];
    try {
        configuredHosts = (await SSHConfiguration.loadFromFS()).getAllConfiguredHosts();
    } catch {
        // Ignore and fall back to the plain input box below.
    }

    if (!configuredHosts.length) {
        return vscode.window.showInputBox({
            title: 'Enter [user@]hostname[:port]'
        });
    }

    const hostItems: vscode.QuickPickItem[] = configuredHosts.map(label => ({ label }));

    return new Promise<string | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = 'Connect to Host';
        quickPick.placeholder = 'Select a configured host, or enter [user@]hostname[:port]';
        quickPick.items = hostItems;

        quickPick.onDidChangeValue(value => {
            const typed = value.trim();
            quickPick.items = typed && !configuredHosts.includes(typed)
                ? [{ label: typed, description: 'Connect to this host' }, ...hostItems]
                : hostItems;
        });

        quickPick.onDidAccept(() => {
            const picked = quickPick.selectedItems[0]?.label ?? quickPick.value.trim();
            resolve(picked || undefined);
            quickPick.hide();
        });

        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });

        quickPick.show();
    });
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

    const snippet = '\nHost ${1:dev}\n\tHostName ${2:dev.example.com}\n\tUser ${3:john}';

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
