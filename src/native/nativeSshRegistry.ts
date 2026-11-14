import * as path from 'path';
import * as fs from 'fs/promises';
import { getProductJson } from '../server-config/get-product-json';
import { ServerInstallResult } from '../serverSetup';

export type NativeSshRegistryEntry = {
    schemaVersion: number;
    socketPath: string;
    socksPort: number;
    pid: number;
} & ServerInstallResult;

export class NativeSshRegistry {
    private constructor(private readonly registryFilePath: string) { }

    static async forAuthority(
        globalStorageDir: string,
        authorityKey: string,
        extensionVersion: string
    ): Promise<NativeSshRegistry> {
        const productJson = await getProductJson();
        return new NativeSshRegistry(
            path.join(
                globalStorageDir,
                'native-ssh',
                `ssh-host-${authorityKey}-${productJson.commit as string}-${extensionVersion}`,
                'data.json'
            )
        );
    }

    get filePath(): string {
        return this.registryFilePath;
    }

    async read(): Promise<NativeSshRegistryEntry | undefined> {
        try {
            const raw = await fs.readFile(this.registryFilePath, 'utf8');
            const parsed = JSON.parse(raw) as NativeSshRegistryEntry;
            return isValidRegistryEntry(parsed) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    async write(entry: NativeSshRegistryEntry): Promise<void> {
        await fs.mkdir(path.dirname(this.registryFilePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.registryFilePath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
        await fs.rename(tmp, this.registryFilePath);
    }

    async removeIfOwnedBy(pid: number): Promise<void> {
        const entry = await this.read();
        if (!entry || entry.pid !== pid) {
            return;
        }
        try {
            await fs.unlink(this.registryFilePath);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
    }
}

function isValidRegistryEntry(value: unknown): value is NativeSshRegistryEntry {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const v = value as Record<string, unknown>;
    return (
        typeof v.socketPath === 'string' && v.socketPath.length > 0 &&
        typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 &&
        typeof v.connectionToken === 'string' && v.connectionToken.length > 0 &&
        (
            typeof v.listeningOn === 'string' && v.listeningOn.length > 0 ||
            typeof v.listeningOn === 'number' && Number.isInteger(v.listeningOn) && v.listeningOn > 0
        )
    );
}
