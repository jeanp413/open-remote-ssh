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

async function fixture(dir: string, command = process.execPath, args = ['-e', 'process.stdin.resume()']) {
    const script = join(dir, 'nativeSshServer.js');
    const source = await readFile('src/native/nativeSshServer.ts', 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    await writeFile(script, compiled);
    return new NativeSshManager({
        connection: {
            authorityKey: 'test',
            sshExecutable: command,
            sshArgs: args,
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
}

it('starts the native helper without deleting its entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-helper-'));
    const manager = await fixture(dir);
    const script = join(dir, 'nativeSshServer.js');
    const source = await readFile(script, 'utf8');

    try {
        const server = await manager['spawnFresh']();
        expect(await readFile(script, 'utf8')).toBe(source);
        expect(await new NativeSshServerClient(server.socketPath).isHealthy()).toBe(true);
    } finally {
        await manager.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});

it.skipIf(process.platform === 'win32')('initializes from shell readiness without authentication diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-ready-'));
    const manager = await fixture(dir, 'bash', ['--noprofile', '--norc']);
    const installed = {
        exitCode: 0, listeningOn: 12345, connectionToken: 'token', logFile: '',
        osReleaseId: '', arch: 'x64', platform: 'linux', tmpDir: dir,
    };
    manager['nativeInstallCodeServer'] = async () => installed;
    // Stop the real helper if a regression leaves initialization waiting forever.
    const watchdog = setTimeout(() => { void manager.dispose(); }, 4000);

    try {
        const result = await manager.initialize({
            serverDownloadUrlTemplate: undefined, serverVersion: 'match', extensionIds: [],
            envVariables: [], useSocketPath: false, customInstallPath: undefined,
            extensionPath: dir, remotePlatform: 'linux',
        });
        expect(result).toMatchObject(installed);
        expect(await new NativeSshServerClient(result.socketPath).isHealthy()).toBe(true);
    } finally {
        clearTimeout(watchdog);
        await manager.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
