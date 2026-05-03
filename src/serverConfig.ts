import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { fetchRelease } from './fetchRelease';
import Log from './common/logger';

let vscodeProductJson: Record<string, unknown>;

async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
    }

    return vscodeProductJson;
}

export interface IServerConfig {
    version: string;
    commit: string;
    quality: string;
    release?: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate?: string;
    modifyMatchingCommit: boolean;
}

export async function getVSCodeServerConfig(logger: Log): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    const customServerBinaryName = vscode.workspace.getConfiguration('remote.SSH.experimental').get<string>('serverBinaryName', '');
    const customModifyMatchingCommit = vscode.workspace.getConfiguration('remote.SSH.experimental').get<boolean>('modifyMatchingCommit', false);

    // Get release, if the option is provided or fetch it from the github releases
    const version = vscode.version.replace('-insider','');
    let customRelease = vscode.workspace.getConfiguration('remote.SSH.experimental').get<string>('vscodiumReleaseNumber', '');
    customRelease = customRelease || productJson.release as string;
    if (!customRelease) {
        customRelease = await fetchRelease(version, logger);
    }

    return {
        version: version,
        commit: productJson.commit as string,
        quality: productJson.quality as string,
        release: customRelease as string,
        serverApplicationName: customServerBinaryName || productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        serverDownloadUrlTemplate: productJson.serverDownloadUrlTemplate as string,
        modifyMatchingCommit: customModifyMatchingCommit,
    };
}
