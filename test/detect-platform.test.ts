import { describe, expect, it, vi } from 'vitest';
import { detectPlatform, parseKernelName, parseMachineArch, ServerInstallError } from '../src/serverSetup';

type ExecResult = { stdout: string; stderr: string };

/**
 * Fake connection: maps a command to its canned output. Any unexpected command fails the test.
 */
function fakeConn(responses: Record<string, ExecResult>) {
    const exec = vi.fn(async (cmd: string): Promise<ExecResult> => {
        const response = responses[cmd];
        if (!response) {
            throw new Error(`unexpected command: ${cmd}`);
        }
        return response;
    });

    return { exec };
}

const out = (stdout: string): ExecResult => ({ stdout, stderr: '' });
const err = (stderr: string): ExecResult => ({ stdout: '', stderr });

const logger = { trace: vi.fn() };

describe('parseKernelName', () => {
    it.each([
        ['Darwin', 'darwin'],
        ['Linux', 'linux'],
        ['FreeBSD', 'freebsd'],
        ['DragonFly', 'dragonfly'],
    ])('maps %s to %s', (input, expected) => {
        expect(parseKernelName(input)).to.eql(expected);
    });

    it('rejects unsupported kernels', () => {
        expect(() => parseKernelName('SunOS')).toThrow(ServerInstallError);
        expect(() => parseKernelName('SunOS')).toThrow('platform not supported: SunOS');
    });
});

describe('parseMachineArch', () => {
    it.each([
        ['x86_64', 'x64'],
        ['amd64', 'x64'],
        ['armv7l', 'armhf'],
        ['armv8l', 'armhf'],
        ['arm64', 'arm64'],
        ['aarch64', 'arm64'],
        ['ppc64le', 'ppc64le'],
        ['riscv64', 'riscv64'],
        ['loongarch64', 'loong64'],
        ['s390x', 's390x'],
    ])('maps %s to %s', (input, expected) => {
        expect(parseMachineArch(input)).to.eql(expected);
    });

    it('rejects unsupported architectures', () => {
        expect(() => parseMachineArch('i686')).toThrow(ServerInstallError);
        expect(() => parseMachineArch('i686')).toThrow('architecture not supported: i686');
    });
});

describe('detectPlatform', () => {
    describe('unix-like hosts', () => {
        it('detects linux/x64 and trims trailing newlines', async () => {
            const conn = fakeConn({ 'uname -s': out('Linux\n'), 'uname -m': out('x86_64\n') });

            await expect(detectPlatform(conn, undefined, logger)).resolves.to.eql({
                detectedPlatform: 'linux',
                detectedArch: 'x64',
                detectedShell: 'bash',
            });
        });

        it('detects darwin/arm64', async () => {
            const conn = fakeConn({ 'uname -s': out('Darwin\n'), 'uname -m': out('arm64\n') });

            await expect(detectPlatform(conn, undefined, logger)).resolves.to.eql({
                detectedPlatform: 'darwin',
                detectedArch: 'arm64',
                detectedShell: 'bash',
            });
        });

        it('detects freebsd/amd64', async () => {
            const conn = fakeConn({ 'uname -s': out('FreeBSD\n'), 'uname -m': out('amd64\n') });

            const result = await detectPlatform(conn, undefined, logger);

            expect(result.detectedPlatform).to.eql('freebsd');
            expect(result.detectedArch).to.eql('x64');
        });

        it('fails on an unsupported kernel', async () => {
            const conn = fakeConn({ 'uname -s': out('SunOS\n') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('platform not supported: SunOS');
        });

        it('fails on an unsupported architecture', async () => {
            const conn = fakeConn({ 'uname -s': out('Linux\n'), 'uname -m': out('i686\n') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('architecture not supported: i686');
        });

        it('fails when "uname -s" yields an empty result', async () => {
            const conn = fakeConn({ 'uname -s': out('\n') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('"uname -s" yields empty result');
        });

        it('fails when "uname -m" yields an empty result', async () => {
            const conn = fakeConn({ 'uname -s': out('Linux'), 'uname -m': out('') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('"uname -m" yields empty result');
        });

        it('fails when "uname -s" writes an unknown error', async () => {
            const conn = fakeConn({ 'uname -s': err('sh: uname: not found') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('Cannot execute "uname -s", yields: sh: uname: not found');
        });

        it('fails when "uname -m" writes an error', async () => {
            const conn = fakeConn({ 'uname -s': out('Linux'), 'uname -m': err('boom') });

            await expect(detectPlatform(conn, undefined, logger)).rejects.toThrow('Cannot execute "uname -m", yields: boom');
        });
    });

    describe('windows hosts', () => {
        it('detects powershell from CommandNotFoundException', async () => {
            const conn = fakeConn({
                'uname -s': err('uname : The term \'uname\' is not recognized...\n    + FullyQualifiedErrorId : CommandNotFoundException'),
            });

            await expect(detectPlatform(conn, undefined, logger)).resolves.to.eql({
                detectedPlatform: 'windows',
                detectedArch: 'x64',
                detectedShell: 'powershell',
            });
            // architecture is not probed on windows
            expect(conn.exec).toHaveBeenCalledTimes(1);
        });

        it('detects cmd from "is not recognized as an internal or external command"', async () => {
            const conn = fakeConn({
                'uname -s': err('\'uname\' is not recognized as an internal or external command,\r\noperable program or batch file.'),
            });

            const result = await detectPlatform(conn, undefined, logger);

            expect(result).to.eql({ detectedPlatform: 'windows', detectedArch: 'x64', detectedShell: 'cmd' });
        });

        it('detects powershell from windows32 (GnuWin32 uname)', async () => {
            const conn = fakeConn({ 'uname -s': out('windows32\r\n') });

            const result = await detectPlatform(conn, undefined, logger);

            expect(result).to.eql({ detectedPlatform: 'windows', detectedArch: 'x64', detectedShell: 'powershell' });
        });

        it('detects bash from MINGW64 (Git Bash)', async () => {
            const conn = fakeConn({ 'uname -s': out('MINGW64_NT-10.0-19045\n') });

            const result = await detectPlatform(conn, undefined, logger);

            expect(result).to.eql({ detectedPlatform: 'windows', detectedArch: 'x64', detectedShell: 'bash' });
        });

        it('still probes when remotePlatform is "windows"', async () => {
            const conn = fakeConn({ 'uname -s': out('MINGW64_NT-10.0\n') });

            const result = await detectPlatform(conn, 'windows', logger);

            expect(result.detectedShell).to.eql('bash');
            expect(conn.exec).toHaveBeenCalledWith('uname -s');
        });
    });

    describe('remote.SSH.remotePlatform override', () => {
        it('skips "uname -s" for "linux" but still probes the architecture', async () => {
            const conn = fakeConn({ 'uname -m': out('aarch64\n') });

            const result = await detectPlatform(conn, 'linux', logger);

            expect(result).to.eql({ detectedPlatform: 'linux', detectedArch: 'arm64', detectedShell: 'bash' });
            expect(conn.exec).not.toHaveBeenCalledWith('uname -s');
        });

        it('maps "macos" to darwin', async () => {
            const conn = fakeConn({ 'uname -m': out('arm64\n') });

            const result = await detectPlatform(conn, 'macos', logger);

            expect(result).to.eql({ detectedPlatform: 'darwin', detectedArch: 'arm64', detectedShell: 'bash' });
        });
    });
});
