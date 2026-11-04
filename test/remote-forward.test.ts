import * as os from 'node:os';
import * as path from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    MalformedRemoteForwardError,
    parseRemoteForward,
    UnsupportedRemoteForwardError,
} from '../src/ssh/remoteForward';
import { SSHConfiguration } from './rewires/remote';

const USER_CONFIG = path.join(os.homedir(), '.ssh', 'config');

describe('RemoteForward configuration', () => {
    beforeEach(() => {
        vol.reset();
    });

    it('normalizes mixed-case directives without losing repeated forwards', async () => {
        vol.fromJSON({
            [USER_CONFIG]: [
                'Host target',
                '  RemoteForward 1000 first.example:2000',
                '  remoteforward 1001 second.example:2001',
                '  rEmOtEfOrWaRd 1002 third.example:2002',
                '  eXiToNfOrWaRdFaIlUrE YeS',
                '  CLEARALLFORWARDINGS nO',
            ].join('\n'),
        });

        const config = await SSHConfiguration.loadFromFS();
        const target = config.getHostConfiguration('target');

        expect(target.RemoteForward).to.eql([
            '1000 first.example:2000',
            '1001 second.example:2001',
            '1002 third.example:2002',
        ]);
        expect(target.ExitOnForwardFailure).to.eql('YeS');
        expect(target.ClearAllForwardings).to.eql('nO');
    });
});

describe('parseRemoteForward', () => {
    it.each([
        ['9000 127.0.0.1:3000', {
            remotePort: 9000,
            localHost: '127.0.0.1',
            localPort: 3000,
        }],
        ['0 Service.Example.COM:3000', {
            remotePort: 0,
            localHost: 'Service.Example.COM',
            localPort: 3000,
        }],
        ['127.0.0.1:9000 local.service:3000', {
            remoteBindAddress: '127.0.0.1',
            remotePort: 9000,
            localHost: 'local.service',
            localPort: 3000,
        }],
        ['*:9000 localhost:3000', {
            remoteBindAddress: '*',
            remotePort: 9000,
            localHost: 'localhost',
            localPort: 3000,
        }],
        [':9000 localhost:3000', {
            remoteBindAddress: '',
            remotePort: 9000,
            localHost: 'localhost',
            localPort: 3000,
        }],
        ['[::1]:9000 [2001:db8::10]:3000', {
            remoteBindAddress: '::1',
            remotePort: 9000,
            localHost: '2001:db8::10',
            localPort: 3000,
        }],
        ['[fe80::1%eth0]:9000 [fe80::2%enp0s3.100]:3000', {
            remoteBindAddress: 'fe80::1%eth0',
            remotePort: 9000,
            localHost: 'fe80::2%enp0s3.100',
            localPort: 3000,
        }],
        ['  9000   exact-host.example:3000  ', {
            remotePort: 9000,
            localHost: 'exact-host.example',
            localPort: 3000,
        }],
    ])('parses %s', (value, expected) => {
        expect(parseRemoteForward(value)).to.eql(expected);
    });

    it.each([
        '',
        '9000 localhost:3000 extra',
        'host:bad localhost:3000',
        'host:65536 localhost:3000',
        '-1 localhost:3000',
        '9000 localhost:0',
        '9000 localhost:65536',
        '9000 :3000',
        '[::1:9000 localhost:3000',
        '[::1]9000 localhost:3000',
        '::1:9000 localhost:3000',
        '9000 2001:db8::10:3000',
        '[fe80::1%]:9000 localhost:3000',
        '[fe80::1%eth0%extra]:9000 localhost:3000',
        '"9000 localhost:3000',
        '9000 localhost:3000\\',
    ])('rejects malformed syntax: %s', (value) => {
        expect(() => parseRemoteForward(value)).toThrow(MalformedRemoteForwardError);
    });

    it.each([
        '9000 host-%h:3000',
        '%p localhost:3000',
        '9000 %%:3000',
        '[%h]:9000 localhost:3000',
    ])('reports unsupported OpenSSH expansions: %s', (value) => {
        expect(() => parseRemoteForward(value)).toThrow(UnsupportedRemoteForwardError);
        expect(() => parseRemoteForward(value)).toThrow(/% expansion tokens/);
    });

    it.each([
        '9000',
        'localhost:9000',
        '[::1]:9000',
    ])('reports remote dynamic TCP forwarding separately: %s', (value) => {
        expect(() => parseRemoteForward(value)).toThrow(UnsupportedRemoteForwardError);
        expect(() => parseRemoteForward(value)).toThrow(/remote dynamic TCP forwarding/);
    });

    it.each([
        '/tmp/remote.sock',
        './remote.sock',
        'remote.sock',
    ])('reports single-argument Unix socket forwarding separately: %s', (value) => {
        expect(() => parseRemoteForward(value)).toThrow(UnsupportedRemoteForwardError);
        expect(() => parseRemoteForward(value)).toThrow(/single-argument Unix socket forwarding/);
    });

    it.each([
        ['/tmp/remote.sock localhost:3000', /remote Unix socket forwarding/],
        ['9000 /tmp/local.sock', /local Unix socket forwarding/],
        ['/tmp/remote.sock /tmp/local.sock', /remote Unix socket forwarding/],
        ['localhost/9000 destination/3000', /slash-delimited OpenSSH forwarding syntax/],
    ])('reports unsupported syntax: %s', (value, message) => {
        expect(() => parseRemoteForward(value)).toThrow(UnsupportedRemoteForwardError);
        expect(() => parseRemoteForward(value)).toThrow(message);
    });
});
