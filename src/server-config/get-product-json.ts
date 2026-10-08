import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let data: Record<string, unknown>;

export async function getProductJson(): Promise<Record<string, unknown>> {
    if (!data) {
        const content = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');

        data = JSON.parse(content);
    }

    return data;
}
