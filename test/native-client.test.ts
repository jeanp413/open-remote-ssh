import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import NativeSSHConnection, { isGssapiAuthenticationRequested } from '../src/ssh/nativeClient';
import type { HostConfiguration } from '../src/ssh/sshConfig';
import { Log } from './mocks/logger';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: spawnMock }));

/**
 * Minimal ChildProcess stand-in: only the surface `nativeClient` touches
 * (stdout/stderr streams, exit events, kill) is implemented.
 */
class FakeChildProcess extends EventEmitter {
    // PassThrough mirrors a real child's stdio: writes made before a consumer
    // attaches a `data` listener stay buffered instead of being lost.
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;

    kill(signal = 'SIGTERM'): boolean {
        if (this.exitCode !== null || this.signalCode !== null) {
            return false;
        }
        this.killed = true;
        this.signalCode = signal;
        this.end(null, signal);
        return true;
    }

    /**
     * Mirrors Node's child process lifecycle: `exit` fires first, `close`
     * after the stdio streams have drained.
     */
    end(code: number | null, signal: string | null): void {
        queueMicrotask(() => {
            this.emit('exit', code, signal);
            this.emit('close', code, signal);
        });
    }

    /** Simulate the process ending by itself with the given exit code. */
    simulateExit(code: number): void {
        this.exitCode = code;
        this.end(code, null);
    }

    simulateStdout(text: string): void {
        this.stdout.write(Buffer.from(text));
    }

    simulateStderr(text: string): void {
        this.stderr.write(Buffer.from(text));
    }
}

type SpawnFactory = (args: string[]) => FakeChildProcess;

/** A master that authenticates fine: `-O check` answers with exit 0. */
const healthyMasterFactory: SpawnFactory = args => {
    if (args.includes('check')) {
        const check = new FakeChildProcess();
        check.simulateExit(0);
        return check;
    }
    return new FakeChildProcess();
};

function spawnCheck(exitCode: number): FakeChildProcess {
    const check = new FakeChildProcess();
    check.simulateExit(exitCode);
    return check;
}

function mockSpawn(factory: SpawnFactory): FakeChildProcess[] {
    spawnMock.mockClear();
    const children: FakeChildProcess[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        const child = factory(args);
        children.push(child);
        return child;
    });
    return children;
}

const logger = new Log('test');

/** Starts a real local listener so `-L`/`-D` readiness probes can connect. */
async function withLocalListener<T>(fn: (port: number) => Promise<T>): Promise<T> {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
        return await fn(port);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

const baseConfig = {
    destination: 'k8s-dev',
    configFile: '/tmp/test-ssh-config',
    dynamicForwarding: false,
    readyTimeout: 5000,
    logger
};

describe('isGssapiAuthenticationRequested', () => {
    const cases: Array<{ name: string; config: HostConfiguration; expected: boolean }> = [
        { name: 'GSSAPIAuthentication yes', config: { GSSAPIAuthentication: 'yes' }, expected: true },
        { name: 'point-to-point variant', config: { GSSAPIAuthentication: 'yes-point-to-point' }, expected: true },
        { name: 'case-insensitive value', config: { GSSAPIAuthentication: 'YES' }, expected: true },
        { name: 'explicit no', config: { GSSAPIAuthentication: 'no' }, expected: false },
        { name: 'gssapi-with-mic listed first', config: { PreferredAuthentications: 'gssapi-with-mic,publickey' }, expected: true },
        { name: 'gssapi-with-mic with spaces', config: { PreferredAuthentications: ' publickey , gssapi-with-mic ' }, expected: true },
        { name: 'other methods only', config: { PreferredAuthentications: 'publickey,password' }, expected: false },
        { name: 'no relevant directives', config: {}, expected: false }
    ];

    for (const { name, config, expected } of cases) {
        it(name, () => {
            expect(isGssapiAuthenticationRequested(config)).toBe(expected);
        });
    }
});

describe('NativeSSHConnection', () => {
    afterAll(() => {
        spawnMock.mockRestore();
    });

    it('spawns a ControlMaster with batch mode and probes it until ready', async () => {
        const children = mockSpawn(healthyMasterFactory);

        await new NativeSSHConnection(baseConfig).connect();

        const masterArgs = spawnMock.mock.calls[0][1] as string[];
        expect(masterArgs).toContain('BatchMode=yes');
        expect(masterArgs).toContain('ControlMaster=yes');
        expect(masterArgs[masterArgs.indexOf('-F') + 1]).toBe('/tmp/test-ssh-config');
        expect(masterArgs.filter(arg => arg.startsWith('ControlPath='))).toHaveLength(1);
        expect(masterArgs[masterArgs.length - 1]).toBe('k8s-dev');
        expect(children.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects with the ssh stderr when the master dies before becoming ready', async () => {
        mockSpawn(args => {
            if (args.includes('check')) {
                return spawnCheck(1);
            }
            // The master is silent at first and only fails after the
            // extension has attached its stderr listener, like a real ssh.
            const master = new FakeChildProcess();
            queueMicrotask(() => {
                master.simulateStderr('kex_exchange_identification: Connection closed by remote host');
                master.simulateExit(255);
            });
            return master;
        });

        await expect(new NativeSSHConnection(baseConfig).connect())
            .rejects.toThrow('kex_exchange_identification');
    });

    it('times out when the master never becomes ready', async () => {
        vi.useFakeTimers();
        try {
            mockSpawn(args => {
                if (args.includes('check')) {
                    return spawnCheck(1);
                }
                return new FakeChildProcess();
            });
            const connect = new NativeSSHConnection({ ...baseConfig, readyTimeout: 300 }).connect();
            const assertion = expect(connect).rejects.toThrow('Timed out');
            await vi.runAllTimersAsync();
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs commands through the master connection and aggregates output', async () => {
        mockSpawn(args => {
            if (args.includes('check')) {
                const check = new FakeChildProcess();
                check.simulateExit(0);
                return check;
            }
            if (args[args.length - 1] === 'uname') {
                const exec = new FakeChildProcess();
                queueMicrotask(() => {
                    exec.simulateStdout('Linux\n');
                    exec.simulateExit(0);
                });
                return exec;
            }
            return new FakeChildProcess();
        });

        const connection = new NativeSSHConnection(baseConfig);
        await connection.connect();
        const result = await connection.exec('uname');

        expect(result).toEqual({ stdout: 'Linux\n', stderr: '' });
        const execArgs = spawnMock.mock.calls.at(-1)![1] as string[];
        expect(execArgs.slice(-1)).toEqual(['uname']);
        expect(execArgs.some(arg => arg.startsWith('ControlPath='))).toBe(true);
    });

    it('rejects exec when the ssh client itself fails', async () => {
        mockSpawn(args => {
            if (args.includes('check')) {
                const check = new FakeChildProcess();
                check.simulateExit(0);
                return check;
            }
            if (args[args.length - 1] === 'uname') {
                const exec = new FakeChildProcess();
                queueMicrotask(() => {
                    exec.simulateStderr('Permission denied (gssapi-with-mic)');
                    exec.simulateExit(255);
                });
                return exec;
            }
            return new FakeChildProcess();
        });

        const connection = new NativeSSHConnection(baseConfig);
        await connection.connect();

        await expect(connection.exec('uname')).rejects.toThrow('Permission denied');
    });

    it('resolves execPartial as soon as the tester matches', async () => {
        mockSpawn(args => {
            if (args.includes('check')) {
                return spawnCheck(0);
            }
            if (args.includes('ControlMaster=yes')) {
                // The master connection must stay alive while the command runs.
                return new FakeChildProcess();
            }
            const exec = new FakeChildProcess();
            queueMicrotask(() => {
                exec.simulateStdout('start ');
                exec.simulateStdout('script-id: end');
                exec.simulateStdout(' trailing output that never gets tested');
                exec.simulateExit(0);
            });
            return exec;
        });

        const connection = new NativeSSHConnection(baseConfig);
        await connection.connect();
        const result = await connection.execPartial('script', stdout => stdout.includes('script-id: end'));

        expect(result.stdout).toContain('script-id: end');
    });

    it('opens an -L tunnel and closes it again', async () => {
        await withLocalListener(async listenerPort => {
            let forwardChild: FakeChildProcess | undefined;
            mockSpawn(args => {
                if (args.includes('check')) {
                    const check = new FakeChildProcess();
                    check.simulateExit(0);
                    return check;
                }
                if (args.some(arg => arg.startsWith('-L'))) {
                    // The tunnel port is already listening (our test server),
                    // so the readiness probe connects immediately.
                    forwardChild = new FakeChildProcess();
                    return forwardChild;
                }
                return new FakeChildProcess();
            });

            const connection = new NativeSSHConnection(baseConfig);
            await connection.connect();
            const tunnel = await connection.addTunnel({
                name: 'tunnel-test',
                remoteAddr: '127.0.0.1',
                remotePort: listenerPort,
                localPort: listenerPort
            });

            expect(tunnel.localPort).toBe(listenerPort);
            const forwardArgs = spawnMock.mock.calls.find(([, args]) => (args as string[]).some(arg => arg.startsWith('-L')))![1] as string[];
            expect(forwardArgs).toContain('-L');
            expect(forwardArgs).toContain(`${listenerPort}:127.0.0.1:${listenerPort}`);

            await connection.closeTunnel('tunnel-test');
            expect(forwardChild?.killed).toBe(true);
        });
    });

    it('reuses the -D listener opened on the master for SOCKS tunnels', async () => {
        const children = mockSpawn(args => {
            if (args.includes('check')) {
                const check = new FakeChildProcess();
                check.simulateExit(0);
                return check;
            }
            return new FakeChildProcess();
        });

        const connection = new NativeSSHConnection({ ...baseConfig, dynamicForwarding: true });
        await connection.connect();

        const masterArgs = spawnMock.mock.calls[0][1] as string[];
        const dashDIndex = masterArgs.indexOf('-D');
        expect(dashDIndex).toBeGreaterThanOrEqual(0);
        const socksPort = Number(masterArgs[dashDIndex + 1].split(':')[1]);
        expect(socksPort).toBeGreaterThan(0);

        const tunnel = await connection.addTunnel({ name: 'socks', socks: true });
        expect(tunnel.localPort).toBe(socksPort);
        expect(tunnel.server).toBe(children[0]);

        await connection.close();
        expect(children[0].killed).toBe(true);
    });

    it('exposes execChannel output and terminates the process on close', async () => {
        mockSpawn(args => {
            if (args.includes('check')) {
                const check = new FakeChildProcess();
                check.simulateExit(0);
                return check;
            }
            if (args[args.length - 1].startsWith('echo')) {
                const exec = new FakeChildProcess();
                queueMicrotask(() => exec.simulateStdout('/tmp/agent.sock\n'));
                return exec;
            }
            return new FakeChildProcess();
        });

        const connection = new NativeSSHConnection(baseConfig);
        await connection.connect();
        const channel = await connection.execChannel('echo "$SSH_AUTH_SOCK"; exec cat');

        const chunks: string[] = [];
        const closed = new Promise<void>(resolve => channel.on('close', resolve));
        channel.on('data', chunk => chunks.push(chunk.toString()));
        await vi.waitFor(() => expect(chunks.join('')).toContain('/tmp/agent.sock'));

        channel.close();
        await closed;
    });
});
