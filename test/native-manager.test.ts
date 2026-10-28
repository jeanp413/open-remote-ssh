import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { NativeSshManager, NativeSshRegistry } from '../src/native/nativeSshManager';
import { NativeSshServerClient } from '../src/native/nativeSshServerClient';
import { Log } from './mocks/logger';

vi.mock('../src/server-config/get-product-json', () => ({
    getProductJson: async () => ({ commit: 'test' }),
}));

it('starts the native helper without deleting its entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-helper-'));
    const script = join(dir, 'nativeSshServer.js');
    const source = await readFile('src/native/nativeSshServer.ts', 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const manager = new NativeSshManager({
        connection: {
            authorityKey: 'test',
            sshExecutable: process.execPath,
            sshArgs: ['-e', 'process.stdin.resume()'],
            label: 'test',
            remotePlatform: 'linux',
            socksPort: 12345,
        },
        registry: await NativeSshRegistry.forAuthority(dir, 'test'),
        serverScriptPath: script,
        askpassPath: '',
        askpassNodeScriptPath: '',
        askpassSocketPath: '',
        logger: new Log('test'),
    });

    try {
        await writeFile(script, compiled);
        const server = await manager['spawnFresh']();
        expect(await readFile(script, 'utf8')).toBe(compiled);
        expect(await new NativeSshServerClient(server.socketPath).isHealthy()).toBe(true);
    } finally {
        await manager.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
