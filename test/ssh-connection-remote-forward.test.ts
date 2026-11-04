import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ClientChannel, TcpConnectionDetails } from 'ssh2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient extends EventEmitter {
    forwardIn: ReturnType<typeof vi.fn>;
    unforwardIn: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
}

const ssh = {
    clients: [] as FakeClient[],
    forwardInError: undefined as Error | undefined,
    forwardInErrorsByPort: new Map<number, Error>(),
    assignedPort: 49152,
};

interface FakeSocket extends Duplex {
    readonly connectedTo: { host: string; port: number };
    readonly received: Buffer[];
    send(data: string): void;
}

const network = {
    sockets: [] as FakeSocket[],
    failNextConnection: false,
};

vi.doMock('net', async () => {
    const actual = await vi.importActual<typeof import('net')>('net');

    class Socket extends Duplex implements FakeSocket {
        readonly received: Buffer[] = [];

        constructor(readonly connectedTo: { host: string; port: number }) {
            super();
        }

        _read(): void { }

        _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            this.received.push(Buffer.from(chunk));
            callback();
        }

        send(data: string): void {
            this.push(Buffer.from(data));
        }
    }

    return {
        ...actual,
        connect: vi.fn((options: { host: string; port: number }) => {
            const socket = new Socket(options);
            network.sockets.push(socket);

            queueMicrotask(() => {
                if (network.failNextConnection) {
                    network.failNextConnection = false;
                    socket.emit('error', new Error('connect ECONNREFUSED'));
                } else {
                    socket.emit('connect');
                }
            });

            return socket;
        }),
    };
});

vi.doMock('ssh2', async () => {
    const { EventEmitter } = await import('node:events');

    class Client extends EventEmitter {
        forwardIn = vi.fn((remoteAddr: string, remotePort: number, callback: (err: Error | undefined, bindPort: number) => void) => {
            queueMicrotask(() => callback(ssh.forwardInErrorsByPort.get(remotePort) || ssh.forwardInError, remotePort === 0 ? ssh.assignedPort : remotePort));
            return true;
        });

        unforwardIn = vi.fn((_remoteAddr: string, _remotePort: number, callback: (err?: Error) => void) => {
            queueMicrotask(() => callback());
            return true;
        });

        end = vi.fn();

        connect(): this {
            queueMicrotask(() => this.emit('ready'));
            return this;
        }

        constructor() {
            super();
            ssh.clients.push(this as FakeClient);
        }
    }

    return { Client };
});

const { default: SSHConnection } = await import('../src/ssh/sshConnection');
const { applyRemoteForwardConfig } = await import('../src/authResolver');
type SSHConnectionInstance = InstanceType<typeof SSHConnection>;

class TestChannel extends Duplex {
    readonly received: Buffer[] = [];

    _read(): void { }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.received.push(Buffer.from(chunk));
        callback();
    }

    send(data: string): void {
        this.push(Buffer.from(data));
    }
}

async function createConnection(): Promise<{ connection: SSHConnectionInstance; client: FakeClient }> {
    const connection = new SSHConnection({ host: 'ssh.example', username: 'developer' });
    await connection.connect();
    return { connection, client: ssh.clients.at(-1)! };
}

function emitTCPConnection(
    client: FakeClient,
    details: Pick<TcpConnectionDetails, 'destIP' | 'destPort'>,
    channel = new TestChannel(),
): { channel: TestChannel; accept: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> } {
    const accept = vi.fn(() => channel as unknown as ClientChannel);
    const reject = vi.fn();

    client.emit('tcp connection', {
        srcIP: '192.0.2.10',
        srcPort: 54321,
        ...details,
    } satisfies TcpConnectionDetails, accept, reject);

    return { channel, accept, reject };
}

beforeEach(() => {
    ssh.clients.length = 0;
    ssh.forwardInError = undefined;
    ssh.forwardInErrorsByPort.clear();
    ssh.assignedPort = 49152;
    network.sockets.length = 0;
    network.failNextConnection = false;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SSHConnection remote TCP forwarding', () => {
    it('registers forwardIn and preserves an allocated remote port', async () => {
        const { connection, client } = await createConnection();

        const tunnel = await connection.addRemoteTunnel({
            name: 'allocated',
            remoteAddr: '127.0.0.1',
            remotePort: 0,
            localHost: 'Service.Example.COM',
            localPort: 3000,
        });

        expect(client.forwardIn).toHaveBeenCalledWith('127.0.0.1', 0, expect.any(Function));
        expect(tunnel).toMatchObject({
            name: 'allocated',
            remotePort: 49152,
            localHost: 'Service.Example.COM',
        });
        expect(connection.getRemoteTunnel('allocated')).toBe(tunnel);
    });

    it('forwards an incoming SSH channel to the configured local TCP service', async () => {
        const { connection, client } = await createConnection();

        await connection.addRemoteTunnel({
            name: 'data',
            remoteAddr: 'localhost',
            remotePort: 9000,
            localHost: 'Service.Example.COM',
            localPort: 3000,
        });

        const { channel, accept, reject } = emitTCPConnection(client, {
            destIP: 'localhost',
            destPort: 9000,
        });
        channel.send('request');

        await vi.waitFor(() => expect(network.sockets).toHaveLength(1));
        const socket = network.sockets[0];
        await vi.waitFor(() => expect(Buffer.concat(socket.received).toString()).toBe('request'));
        socket.send('reply');
        await vi.waitFor(() => expect(Buffer.concat(channel.received).toString()).toBe('reply'));

        expect(socket.connectedTo).toEqual({ host: 'Service.Example.COM', port: 3000 });
        expect(accept).toHaveBeenCalledOnce();
        expect(reject).not.toHaveBeenCalled();

        channel.destroy();
        await connection.close();
    });

    it('rejects incoming channels that do not match an active remote tunnel', async () => {
        const { connection, client } = await createConnection();

        const { accept, reject } = emitTCPConnection(client, {
            destIP: 'localhost',
            destPort: 9999,
        });

        expect(reject).toHaveBeenCalledOnce();
        expect(accept).not.toHaveBeenCalled();
        await connection.close();
    });

    it('destroys the SSH channel when the local TCP connection fails', async () => {
        network.failNextConnection = true;
        const { connection, client } = await createConnection();
        await connection.addRemoteTunnel({
            name: 'unavailable',
            remoteAddr: '127.0.0.1',
            remotePort: 9001,
            localHost: '127.0.0.1',
            localPort: 3001,
        });

        const { channel } = emitTCPConnection(client, {
            destIP: '127.0.0.1',
            destPort: 9001,
        });

        await vi.waitFor(() => expect(channel.destroyed).toBe(true));
        await connection.close();
    });

    it('uses the allocated port for cleanup and only unbinds once', async () => {
        const { connection, client } = await createConnection();
        await connection.addRemoteTunnel({
            name: 'cleanup',
            remoteAddr: '127.0.0.1',
            remotePort: 0,
            localHost: 'localhost',
            localPort: 3000,
        });

        await connection.closeRemoteTunnel('cleanup');
        await connection.closeRemoteTunnel('cleanup');

        expect(client.unforwardIn).toHaveBeenCalledOnce();
        expect(client.unforwardIn).toHaveBeenCalledWith('127.0.0.1', 49152, expect.any(Function));
        expect(connection.getRemoteTunnel('cleanup')).toBeUndefined();

        const { accept, reject } = emitTCPConnection(client, {
            destIP: '127.0.0.1',
            destPort: 49152,
        });
        expect(reject).toHaveBeenCalledOnce();
        expect(accept).not.toHaveBeenCalled();

        await connection.close();
    });

    it('cleans registrations, channels, and listeners on disconnect', async () => {
        const { connection, client } = await createConnection();
        await connection.addRemoteTunnel({
            name: 'disconnect',
            remoteAddr: 'localhost',
            remotePort: 9002,
            localHost: '127.0.0.1',
            localPort: 3002,
        });
        const { channel } = emitTCPConnection(client, {
            destIP: 'localhost',
            destPort: 9002,
        });

        client.emit('close');

        expect(connection.getRemoteTunnel('disconnect')).toBeUndefined();
        expect(client.listenerCount('tcp connection')).toBe(0);
        await vi.waitFor(() => expect(channel.destroyed).toBe(true));
        expect(client.unforwardIn).not.toHaveBeenCalled();
    });

    it('reapplies configured tunnels on a replacement connection after disconnect', async () => {
        const hostConfig = { RemoteForward: ['9000 localhost:3000'] };
        const logger = { info: vi.fn(), error: vi.fn() };
        const first = await createConnection();

        await applyRemoteForwardConfig(first.connection, hostConfig, logger);
        first.client.emit('close');
        expect(first.connection.getRemoteTunnel('ssh_config_remote_forward_0')).toBeUndefined();

        const replacement = await createConnection();
        await applyRemoteForwardConfig(replacement.connection, hostConfig, logger);

        expect(first.client.forwardIn).toHaveBeenCalledOnce();
        expect(replacement.client.forwardIn).toHaveBeenCalledOnce();
        expect(replacement.connection.getRemoteTunnel('ssh_config_remote_forward_0')).toMatchObject({
            remotePort: 9000,
            localHost: 'localhost',
            localPort: 3000,
        });
        await replacement.connection.close();
    });

    it('cleans an earlier listener when a later forward fails with ExitOnForwardFailure=yes', async () => {
        ssh.forwardInErrorsByPort.set(9001, new Error('address in use'));
        const { connection, client } = await createConnection();

        await expect(applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 localhost:3000',
                '9001 localhost:3001',
            ],
            ExitOnForwardFailure: 'yes',
        }, { info: vi.fn(), error: vi.fn() })).rejects.toThrow(
            'Failed to establish RemoteForward \'9001 localhost:3001\': address in use',
        );

        expect(client.unforwardIn).toHaveBeenCalledOnce();
        expect(client.unforwardIn).toHaveBeenCalledWith('localhost', 9000, expect.any(Function));
        expect(connection.getRemoteTunnel('ssh_config_remote_forward_0')).toBeUndefined();
        expect(client.end).toHaveBeenCalledOnce();
    });

    it('does not retain a tunnel when forwardIn fails', async () => {
        ssh.forwardInError = new Error('administratively prohibited');
        const { connection, client } = await createConnection();

        await expect(connection.addRemoteTunnel({
            name: 'denied',
            remoteAddr: 'localhost',
            remotePort: 9003,
            localHost: 'localhost',
            localPort: 3000,
        })).rejects.toThrow('administratively prohibited');

        expect(connection.getRemoteTunnel('denied')).toBeUndefined();
        expect(client.unforwardIn).not.toHaveBeenCalled();
        await connection.close();
    });
});
