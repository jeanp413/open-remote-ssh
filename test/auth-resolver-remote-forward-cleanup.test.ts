import { beforeEach, expect, it, vi } from 'vitest';
import type { SSHRemoteTunnelConfig } from '../src/ssh/sshConnection';
import type { HostConfiguration } from '../src/ssh/sshConfig';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';

type MockSSHConnection = {
    connect: ReturnType<typeof vi.fn>;
    addRemoteTunnel: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
};

const state = vi.hoisted(() => ({
    connections: [] as MockSSHConnection[],
    onInstall: undefined as (() => void) | undefined,
}));

vi.mock('../src/ssh/sshConnection', () => ({
    default: class MockSSHConnection {
        connect = vi.fn(async () => this);
        addRemoteTunnel = vi.fn(async (config: SSHRemoteTunnelConfig) => ({
            ...config,
            name: config.name!,
        }));
        close = vi.fn(async () => undefined);

        constructor() {
            state.connections.push(this);
        }
    },
}));

vi.mock('../src/ssh/identityFiles', async importOriginal => ({
    ...await importOriginal<typeof import('../src/ssh/identityFiles')>(),
    gatherIdentityFiles: vi.fn(async () => []),
}));

vi.mock('../src/serverSetup', async importOriginal => ({
    ...await importOriginal<typeof import('../src/serverSetup')>(),
    installCodeServer: vi.fn(async () => {
        state.onInstall?.();
        throw new Error('simulated install failure');
    }),
}));

const { RemoteSSHResolver } = await import('../src/authResolver');
const { default: SSHDestination } = await import('../src/ssh/sshDestination');

type ResolverInternals = {
    sshConnection: unknown;
    connect(
        destination: InstanceType<typeof SSHDestination>,
        sshConfig: { getHostConfiguration(host: string): HostConfiguration },
        useNativeClient: boolean,
    ): Promise<unknown>;
};

beforeEach(() => {
    state.connections.length = 0;
    state.onInstall = undefined;
    vscode.workspace.resetConfiguration();
});

it('closes the connection that registered RemoteForward when later setup fails', async () => {
    const resolver = new RemoteSSHResolver(new vscode.ExtensionContext(), new Log('test'));
    const internals = resolver as unknown as ResolverInternals;
    const replacement = { close: vi.fn(async () => undefined) };
    const sshConfig = {
        getHostConfiguration: () => ({
            HostName: 'ssh.example',
            User: 'developer',
            RemoteForward: ['9000 localhost:3000'],
        }),
    };
    state.onInstall = () => {
        internals.sshConnection = replacement;
    };

    await expect(internals.connect(SSHDestination.parse('target'), sshConfig, false))
        .rejects.toThrow('simulated install failure');

    expect(state.connections).toHaveLength(1);
    const [connection] = state.connections;
    expect(connection.addRemoteTunnel).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
});

it('logs an asynchronous close failure during synchronous disposal', async () => {
    const logger = new Log('test');
    const error = new Error('simulated close failure');
    const connection = { close: vi.fn(() => Promise.reject(error)) };
    const resolver = new RemoteSSHResolver(new vscode.ExtensionContext(), logger);
    const internals = resolver as unknown as ResolverInternals;
    const logError = vi.spyOn(logger, 'error');
    internals.sshConnection = connection;

    expect(() => resolver.dispose()).not.toThrow();

    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
        'Failed to close SSH connection during disposal',
        error,
    ));
    expect(connection.close).toHaveBeenCalledOnce();
});
