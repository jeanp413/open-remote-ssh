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

const knownHosts = await import('../../src/ssh/knownHosts.js');

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

export const {
	loadKnownHosts,
	matchesHost,
	matchHostKey,
	appendHostKey,
	replaceHostKey,
	removeHostFromEntry,
	findConflictingEntries,
	keyFingerprint,
	keyTypeOf,
} = knownHosts;
