import { vi } from 'vitest';
import { fs } from '../mocks/fs';

vi.resetModules();

vi.doMock('node:fs', () => (
	{
		...fs,
		default: fs,
	}
));
vi.doMock('node:fs/promises', () => ({ default: fs.promises }));

// `glob` reaches the filesystem through its own `PathScurry` instance, which
// doesn't go through the mocked `node:fs`. Point it at the in-memory one so
// `Include` directives resolve against the fixture files.
vi.doMock('glob', async () => {
	const glob = await vi.importActual<typeof import('glob')>('glob');

	return {
		...glob,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		glob: (pattern: string, options: any) => glob.glob(pattern, { ...options, fs }),
	};
});

const { getRemoteAuthority, RemoteSSHResolver } = await import('../../src/authResolver.js');
const { default: SSHConfiguration } = await import('../../src/ssh/sshConfig.js');

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

export {
	getRemoteAuthority,
	RemoteSSHResolver,
	SSHConfiguration,
};
