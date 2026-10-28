import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { NativeSshManager, NativeSshRegistry } from '../src/native/nativeSshManager';
import { NativeSshServerClient } from '../src/native/nativeSshServerClient';
import { CommandRunner, LineParser } from '../src/native/nativeSshParser';
import { Log } from './mocks/logger';

vi.mock('../src/server-config/get-product-json', () => ({
    getProductJson: async () => ({
        commit: 'test', quality: 'stable', serverApplicationName: 'test', serverDataFolderName: '.test',
    }),
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

it.skipIf(process.platform === 'win32')('keeps same-authority helpers independent without authentication diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-ready-'));
    const manager = await fixture(dir, 'bash', ['--noprofile', '--norc']);
    const other = await fixture(dir, 'bash', ['--noprofile', '--norc']);
    const installed = {
        exitCode: 0, listeningOn: 12345, connectionToken: 'token', logFile: '',
        osReleaseId: '', arch: 'x64', platform: 'linux', tmpDir: dir,
    };
    manager['nativeInstallCodeServer'] = async () => installed;
    other['nativeInstallCodeServer'] = async () => installed;
    // Stop the real helper if a regression leaves initialization waiting forever.
    const watchdog = setTimeout(() => { void manager.dispose(); void other.dispose(); }, 4000);

    try {
        const inputs = {
            serverDownloadUrlTemplate: undefined, serverVersion: 'match', extensionIds: [],
            envVariables: [], useSocketPath: false, customInstallPath: undefined,
            extensionPath: dir, remotePlatform: 'linux' as const,
        };
        const result = await manager.initialize(inputs);
        expect(result).toMatchObject(installed);
        expect(await new NativeSshServerClient(result.socketPath).isHealthy()).toBe(true);
        const second = await other.initialize(inputs);
        expect(second.pid).not.toBe(result.pid);
        expect(second.socketPath).not.toBe(result.socketPath);
        await manager.dispose();
        expect(await new NativeSshServerClient(second.socketPath).isHealthy()).toBe(true);
        expect(await other.runCommand('echo independent', stdout => stdout)).toBe('independent');
    } finally {
        clearTimeout(watchdog);
        await manager.dispose();
        await other.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});

it('allows server installation to finish after the ordinary command deadline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-install-'));
    const manager = await fixture(dir);
    await mkdir(join(dir, 'lib', 'scripts'), { recursive: true });
    await copyFile('src/scripts/server-setup.sh', join(dir, 'lib', 'scripts', 'server-setup.sh'));
    manager['nativeDetectPlatform'] = async () => ({
        detectedPlatform: 'linux', detectedArch: 'x64', detectedShell: 'bash',
    });
    const stdout = new LineParser();
    let sent = false;
    manager['cmdRunner'] = new CommandRunner(stdout, new LineParser(), async (command) => {
        if (command.startsWith('bash -c ')) {
            stdout.push('==test==\n');
            return;
        }
        sent = true;
    });
    vi.useFakeTimers();

    try {
        const result = manager['nativeInstallCodeServer']({
            serverDownloadUrlTemplate: undefined, serverVersion: 'match', extensionIds: [],
            envVariables: [], useSocketPath: false, customInstallPath: undefined,
            extensionPath: dir, remotePlatform: 'linux',
        }).then(value => ({ value }), error => ({ error }));
        await vi.waitFor(() => expect(sent).toBe(true));
        await vi.advanceTimersByTimeAsync(11_000);
        stdout.push('test: start\nexitCode==0==\nlisteningOn==12345==\nconnectionToken==token==\ntest: end\n');
        expect(await result).toMatchObject({ value: { exitCode: 0, listeningOn: 12345 } });
    } finally {
        vi.useRealTimers();
        await manager.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});

it.each([
    ['configured', undefined],
    ['cmd', 'C:\\Windows\\System32\\cmd.exe~$PSHOME'],
    ['powershell', '%COMSPEC%~C:\\Windows\\System32\\WindowsPowerShell\\v1.0'],
])('rejects %s Windows remotes before installation', async (_, response) => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-windows-'));
    const manager = await fixture(dir);
    // An unavailable helper must not obscure the configured-platform error.
    await rm(join(dir, 'nativeSshServer.js'));
    const stdout = new LineParser();
    const commands: string[] = [];
    manager['cmdRunner'] = new CommandRunner(stdout, new LineParser(), async command => {
        commands.push(command);
        stdout.push(response + '\n');
    });
    const inputs = {
        serverDownloadUrlTemplate: undefined, serverVersion: 'match', extensionIds: [],
        envVariables: [], useSocketPath: false, customInstallPath: undefined,
        extensionPath: dir, remotePlatform: response ? undefined : 'windows' as const,
    };
    try {
        await expect(response ? manager['nativeInstallCodeServer'](inputs) : manager.initialize(inputs))
            .rejects.toThrow('Set remote.SSH.connectionBackend to "ssh2"');
        expect(commands).toEqual(response ? ['echo %COMSPEC%~$PSHOME'] : []);
    } finally {
        await manager.dispose();
        await rm(dir, { recursive: true, force: true });
    }
});
