import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SSHConfig from 'ssh-config';
import * as ts from 'typescript';
import type * as vscode from 'vscode';
import { expect, it, vi } from 'vitest';
import { RemoteSSHResolver } from '../src/authResolver';
import { Log } from '../src/common/logger';
import { AskPassServer } from '../src/native/nativeSshAskpass';
import { NativeSshManager } from '../src/native/nativeSshManager';
import { NativeSshServerClient } from '../src/native/nativeSshServerClient';
import SSHConfiguration from '../src/ssh/sshConfig';
import SSHDestination from '../src/ssh/sshDestination';
import { workspace } from './mocks/vscode';

vi.mock('../src/server-config/get-product-json', () => ({
    getProductJson: async () => ({
        commit: 'test', quality: 'stable', serverApplicationName: 'test', serverDataFolderName: '.test',
    }),
}));

it.skipIf(process.platform === 'win32')('cleans up a real native helper and askpass after installation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-failure-'));
    const script = join(dir, 'ssh');
    await writeFile(script, '#!/bin/sh\nexec bash --noprofile --norc\n', { mode: 0o700 });
    await mkdir(join(dir, 'lib', 'native'), { recursive: true });
    const source = await readFile('src/native/nativeSshServer.ts', 'utf8');
    await writeFile(join(dir, 'lib', 'native', 'nativeSshServer.js'), ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    const resolver = new RemoteSSHResolver({
        extensionPath: dir, globalStorageUri: { fsPath: dir },
    } as vscode.ExtensionContext, new Log('test'));
    const initialize = vi.spyOn(NativeSshManager.prototype, 'initialize');
    const managers = initialize.mock.contexts as NativeSshManager[];
    const create = vi.spyOn(AskPassServer, 'create');
    workspace.setConfiguration('connectionBackend', 'native');
    workspace.setConfiguration('path', script);
    workspace.setConfiguration('remotePlatform', { test: 'linux' });

    try {
        // The missing installer template fails after the real helper starts its keepalive.
        await expect(resolver['connect'](SSHDestination.parse('test'), new SSHConfiguration(SSHConfig.parse('')), false))
            .rejects.toThrow('ENOENT');
        const manager = managers.at(0)!;
        const askpass = await create.mock.results.at(0)!.value as AskPassServer;
        const info = manager['serverInfo']!;
        expect(await new NativeSshServerClient(info.socketPath).isHealthy()).toBe(false);
        expect(() => process.kill(info.pid, 0)).toThrow();
        expect(manager['keepalive']).toBeUndefined();
        expect(existsSync(askpass.socketPath)).toBe(false);
        expect(resolver['nativeManager']).toBeUndefined();
        expect(resolver['nativeAskpassServer']).toBeUndefined();
    } finally {
        // Also clean up if a regression causes the resource assertions to fail.
        await Promise.all(managers.map(manager => manager.dispose()));
        await Promise.all(create.mock.results.map(async result => (await result.value as AskPassServer).dispose()));
        resolver.dispose();
        vi.restoreAllMocks();
        workspace.resetConfiguration();
        await rm(dir, { recursive: true, force: true });
    }
});
