import { describe, expect, it, vi } from 'vitest';
import { applyRemoteForwardConfig } from '../src/authResolver';
import type { SSHRemoteTunnelConfig } from '../src/ssh/sshConnection';

function createConnection(addRemoteTunnel?: (config: SSHRemoteTunnelConfig) => Promise<SSHRemoteTunnelConfig>) {
    return {
        addRemoteTunnel: vi.fn(addRemoteTunnel || (async config => config)),
        close: vi.fn(async () => undefined),
    };
}

function createLogger() {
    return {
        info: vi.fn(),
        error: vi.fn(),
    };
}

describe('RemoteForward resolver integration', () => {
    it('applies multiple directives sequentially in configuration order', async () => {
        const events: string[] = [];
        const connection = createConnection(async config => {
            events.push(`start:${config.name}`);
            await Promise.resolve();
            events.push(`finish:${config.name}`);
            return {
                ...config,
                remotePort: config.remotePort || 49152,
            };
        });

        await applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 First.Example:3000',
                '*:0 [2001:db8::10]:4000',
                ':9002 localhost:5000',
            ],
        }, createLogger());

        expect(events).to.eql([
            'start:ssh_config_remote_forward_0',
            'finish:ssh_config_remote_forward_0',
            'start:ssh_config_remote_forward_1',
            'finish:ssh_config_remote_forward_1',
            'start:ssh_config_remote_forward_2',
            'finish:ssh_config_remote_forward_2',
        ]);
        expect(connection.addRemoteTunnel.mock.calls.map(([config]) => config)).to.eql([
            {
                name: 'ssh_config_remote_forward_0',
                remoteAddr: 'localhost',
                remotePort: 9000,
                localHost: 'First.Example',
                localPort: 3000,
            },
            {
                name: 'ssh_config_remote_forward_1',
                remoteAddr: '',
                remotePort: 0,
                localHost: '2001:db8::10',
                localPort: 4000,
            },
            {
                name: 'ssh_config_remote_forward_2',
                remoteAddr: '',
                remotePort: 9002,
                localHost: 'localhost',
                localPort: 5000,
            },
        ]);
    });

    it('skips configured listeners when ClearAllForwardings is enabled', async () => {
        const connection = createConnection();

        await applyRemoteForwardConfig(connection, {
            RemoteForward: ['9000 localhost:3000'],
            ClearAllForwardings: 'YeS',
        }, createLogger());

        expect(connection.addRemoteTunnel).not.toHaveBeenCalled();
        expect(connection.close).not.toHaveBeenCalled();
    });

    it('accepts mixed-case yes/no values', async () => {
        const connection = createConnection();

        await applyRemoteForwardConfig(connection, {
            RemoteForward: ['9000 localhost:3000'],
            ClearAllForwardings: 'nO',
            ExitOnForwardFailure: 'yEs',
        }, createLogger());

        expect(connection.addRemoteTunnel).toHaveBeenCalledOnce();
        expect(connection.close).not.toHaveBeenCalled();
    });

    it.each([
        ['ClearAllForwardings', 'true'],
        ['ExitOnForwardFailure', 'maybe'],
    ] as const)('rejects invalid %s values', async (directive, value) => {
        const connection = createConnection();

        await expect(applyRemoteForwardConfig(connection, {
            [directive]: value,
        }, createLogger())).rejects.toThrow(`Invalid ${directive} value '${value}': expected yes or no`);

        expect(connection.addRemoteTunnel).not.toHaveBeenCalled();
        expect(connection.close).toHaveBeenCalledOnce();
    });

    it('logs listener failures and continues by default', async () => {
        const connection = createConnection(async config => {
            if (config.remotePort === 9000) {
                throw new Error('administratively prohibited');
            }
            return config;
        });
        const logger = createLogger();

        await applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 localhost:3000',
                '9001 localhost:3001',
            ],
            ExitOnForwardFailure: 'nO',
        }, logger);

        expect(connection.addRemoteTunnel).toHaveBeenCalledTimes(2);
        expect(connection.close).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to establish RemoteForward \'9000 localhost:3000\''),
            expect.any(Error),
        );
    });

    it('closes the connection and stops after a listener failure when requested', async () => {
        const connection = createConnection(async config => {
            if (config.remotePort === 9001) {
                throw new Error('address in use');
            }
            return config;
        });

        await expect(applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 localhost:3000',
                '9001 localhost:3001',
                '9002 localhost:3002',
            ],
            ExitOnForwardFailure: 'YeS',
        }, createLogger())).rejects.toThrow('Failed to establish RemoteForward \'9001 localhost:3001\': address in use');

        expect(connection.addRemoteTunnel).toHaveBeenCalledTimes(2);
        expect(connection.close).toHaveBeenCalledOnce();
    });

    it.each(['yes', 'no'])('warns and skips unsupported syntax with ExitOnForwardFailure=%s', async exitOnForwardFailure => {
        const connection = createConnection();
        const logger = createLogger();

        await applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 localhost:3000',
                '9001',
                '9002 localhost:3002',
            ],
            ExitOnForwardFailure: exitOnForwardFailure,
        }, logger);

        expect(connection.addRemoteTunnel.mock.calls.map(([config]) => config.remotePort)).to.eql([9000, 9002]);
        expect(connection.close).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(
            /Warning: Skipping unsupported RemoteForward '9001'.*remote dynamic TCP forwarding/,
        ));
    });

    it.each(['yes', 'no'])('rejects malformed syntax with ExitOnForwardFailure=%s', async exitOnForwardFailure => {
        const connection = createConnection();

        await expect(applyRemoteForwardConfig(connection, {
            RemoteForward: [
                '9000 localhost:3000',
                'host:bad localhost:3001',
            ],
            ExitOnForwardFailure: exitOnForwardFailure,
        }, createLogger())).rejects.toThrow(/remote listener port must be a decimal port number/);

        expect(connection.addRemoteTunnel).not.toHaveBeenCalled();
        expect(connection.close).toHaveBeenCalledOnce();
    });
});
