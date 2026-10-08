import type { IServerConfig, ServerValidation } from './types';

import * as vscode from 'vscode';
import { getProductJson } from './get-product-json';

export async function getServerConfig(): Promise<IServerConfig> {
    const productJson = await getProductJson();

    const customServerBinaryName = vscode.workspace.getConfiguration('remote.SSH').get<string>('serverBinaryName', '');
    const serverValidation = vscode.workspace.getConfiguration('remote.SSH').get<ServerValidation>('serverValidation', 'strict');

    return {
        version: vscode.version.replace('-insider',''),
        commit: productJson.commit as string,
        quality: productJson.quality as string,
        release: productJson.release as string || '',
        serverApplicationName: customServerBinaryName || productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        serverDownloadUrlTemplate: productJson.serverDownloadUrlTemplate as string,
        serverValidation,
    };
}
