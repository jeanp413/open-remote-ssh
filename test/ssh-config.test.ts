import * as os from 'node:os';
import * as path from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SSHConfiguration } from './rewires/remote';

const USER_CONFIG = path.join(os.homedir(), '.ssh', 'config');
const USER_CONFIG_DIR = path.join(os.homedir(), '.ssh', 'config.d');

describe('ssh config includes', () => {
	beforeEach(() => {
		vol.reset();
	});

	it('resolves a top-level Include', async () => {
		vol.fromJSON({
			[USER_CONFIG]: 'Include config.d/*\n\nHost local\n  HostName 127.0.0.1\n',
			[path.join(USER_CONFIG_DIR, 'extra')]: 'Host included\n  HostName 10.0.0.1\n',
		});

		const config = await SSHConfiguration.loadFromFS();

		expect(config.getAllConfiguredHosts()).to.eql(['included', 'local']);
		expect(config.getHostConfiguration('included').HostName).to.eql('10.0.0.1');
	});

	it('resolves an Include trailing a Host block', async () => {
		vol.fromJSON({
			[USER_CONFIG]: 'Host local\n  HostName 127.0.0.1\n\nInclude config.d/*\n',
			[path.join(USER_CONFIG_DIR, 'extra')]: 'Host included\n  HostName 10.0.0.1\n',
		});

		const config = await SSHConfiguration.loadFromFS();

		expect(config.getAllConfiguredHosts()).to.eql(['local', 'included']);
		expect(config.getHostConfiguration('local').HostName).to.eql('127.0.0.1');
		expect(config.getHostConfiguration('included').HostName).to.eql('10.0.0.1');
	});

	it('resolves an Include trailing a Match block', async () => {
		vol.fromJSON({
			[USER_CONFIG]: 'Host local\n  HostName 127.0.0.1\n\nMatch all\nInclude config.d/*\n',
			[path.join(USER_CONFIG_DIR, 'extra')]: 'Host included\n  HostName 10.0.0.1\n',
		});

		const config = await SSHConfiguration.loadFromFS();

		expect(config.getAllConfiguredHosts()).to.eql(['local', 'included']);
		expect(config.getHostConfiguration('included').HostName).to.eql('10.0.0.1');
	});

	it('resolves nested Includes', async () => {
		vol.fromJSON({
			[USER_CONFIG]: 'Match all\nInclude config.d/*.conf\n',
			[path.join(USER_CONFIG_DIR, 'first.conf')]: 'Host first\n  HostName 10.0.0.1\n\nInclude config.d/nested/*.conf\n',
			[path.join(USER_CONFIG_DIR, 'nested', 'second.conf')]: 'Host second\n  HostName 10.0.0.2\n',
		});

		const config = await SSHConfiguration.loadFromFS();

		expect(config.getAllConfiguredHosts()).to.eql(['first', 'second']);
		expect(config.getHostConfiguration('second').HostName).to.eql('10.0.0.2');
	});
});
