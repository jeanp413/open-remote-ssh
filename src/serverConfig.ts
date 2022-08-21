import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let vscodeProductJson: any;
async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
    }

    return vscodeProductJson;
}

let vscodePackageJson: any;
async function getVSCodePackageJson() {
    if (!vscodePackageJson) {
        const packageJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'package.json'), 'utf8');
        vscodePackageJson = JSON.parse(packageJsonStr);
    }

    return vscodePackageJson;
}

export interface IServerConfig {
    version: string;
    commit: string;
    quality: string;
    release?: string; // vscodium specific
    serverApplicationName: string;
    serverDataFolderName: string;
}

export async function getVSCodeServerConfig(): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();
    const packageJson = await getVSCodePackageJson();

    return {
        version: vscode.version.replace('-insider',''),
        commit: productJson.commit,
        quality: productJson.quality,
        release: packageJson.release,
        serverApplicationName: productJson.serverApplicationName,
        serverDataFolderName: productJson.serverDataFolderName
    };
}
