import * as crypto from 'node:crypto';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Log } from '../src/common/logger';
import { loadKnownHosts, matchHostKey, appendHostKey, replaceHostKey, removeHostFromEntry, findConflictingEntries, keyFingerprint, keyTypeOf } from './rewires/known-hosts';

const logger = {
	trace: () => {},
	debug: () => {},
	info: () => {},
	error: () => {},
	show: () => {},
} as unknown as Log;

const USER_FILE = '/home/user/.ssh/known_hosts';

/** Builds a key blob in SSH wire format: uint32 type length + type + material */
function fakeKey(type: string, seed: string): Buffer {
	const typeBuffer = Buffer.from(type);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(typeBuffer.length, 0);
	return Buffer.concat([length, typeBuffer, crypto.createHash('sha256').update(seed).digest()]);
}

function hashedPattern(host: string): string {
	const salt = crypto.randomBytes(20);
	const hash = crypto.createHmac('sha1', salt).update(host).digest('base64');
	return `|1|${salt.toString('base64')}|${hash}`;
}

async function load(files: Record<string, string>) {
	vol.reset();
	vol.fromJSON(files);
	return loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
}

const ed25519 = fakeKey('ssh-ed25519', 'the-real-key');
const ed25519Base64 = ed25519.toString('base64');
const otherEd25519 = fakeKey('ssh-ed25519', 'a-different-key');
const rsa = fakeKey('ssh-rsa', 'an-rsa-key');

describe('keyTypeOf', () => {
	it('reads the type from the wire format', () => {
		expect(keyTypeOf(ed25519)).to.eql('ssh-ed25519');
		expect(keyTypeOf(rsa)).to.eql('ssh-rsa');
	});

	it('falls back on malformed blobs', () => {
		expect(keyTypeOf(Buffer.from([1, 2, 3]))).to.eql('unknown');
	});
});

describe('keyFingerprint', () => {
	it('formats like OpenSSH, without base64 padding', () => {
		const fingerprint = keyFingerprint(ed25519);
		expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
	});
});

describe('matchHostKey', () => {
	it('matches a plaintext entry', async () => {
		const { entries } = await load({ [USER_FILE]: `example.com ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
	});

	it('is unknown when the host has no entry', async () => {
		const { entries } = await load({ [USER_FILE]: `other.com ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('is a mismatch when the same key type differs', async () => {
		const { entries } = await load({ [USER_FILE]: `example.com ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('mismatch');
	});

	it('is unknown — not a mismatch — when only another key type is recorded', async () => {
		const { entries } = await load({ [USER_FILE]: `example.com ssh-rsa ${rsa.toString('base64')}\n` });

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('handles [host]:port entries', async () => {
		const { entries } = await load({ [USER_FILE]: `[example.com]:2222 ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'example.com', 2222, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('handles comma-separated names and wildcards', async () => {
		const { entries } = await load({ [USER_FILE]: `alpha.com,*.example.com ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'alpha.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		expect(matchHostKey(entries, 'web1.example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		expect(matchHostKey(entries, 'beta.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('excludes negated names', async () => {
		const { entries } = await load({ [USER_FILE]: `!bad.example.com,*.example.com ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'good.example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		expect(matchHostKey(entries, 'bad.example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('matches |1| hashed entries', async () => {
		const { entries } = await load({ [USER_FILE]: `${hashedPattern('example.com')} ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		expect(matchHostKey(entries, 'other.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('matches hashed [host]:port entries', async () => {
		const { entries } = await load({ [USER_FILE]: `${hashedPattern('[example.com]:2222')} ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'example.com', 2222, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
	});

	it('matches hashed entries case-insensitively, like OpenSSH', async () => {
		// ssh lowercases the hostname before hashing or writing
		const { entries } = await load({ [USER_FILE]: `${hashedPattern('build01.corp.example')} ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'Build01.Corp.Example', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
	});

	it('uses HostKeyAlias instead of the host and port when set', async () => {
		const { entries } = await load({ [USER_FILE]: `stage ssh-ed25519 ${ed25519Base64}\n` });

		expect(matchHostKey(entries, 'localhost', 9922, 'ssh-ed25519', ed25519Base64, 'stage').status).to.eql('match');
		expect(matchHostKey(entries, 'localhost', 9922, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});

	it('refuses a key marked @revoked, even when another entry matches it', async () => {
		const { entries } = await load({
			[USER_FILE]: [
				`example.com ssh-ed25519 ${ed25519Base64}`,
				`@revoked example.com ssh-ed25519 ${ed25519Base64}`,
			].join('\n'),
		});

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('revoked');
	});

	it('a @revoked entry for a different key does not affect the presented one', async () => {
		const { entries } = await load({
			[USER_FILE]: [
				`@revoked example.com ssh-ed25519 ${otherEd25519.toString('base64')}`,
				`example.com ssh-ed25519 ${ed25519Base64}`,
			].join('\n'),
		});

		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
	});

	it('a lone @revoked entry does not count as a recorded key', async () => {
		const { entries } = await load({ [USER_FILE]: `@revoked example.com ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		// The presented (different) key is unknown, not a mismatch against the revoked one
		expect(matchHostKey(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('unknown');
	});
});

describe('loadKnownHosts', () => {
	beforeEach(() => {
		vol.reset();
	});

	it('parses CRLF files', async () => {
		const { entries } = await load({ [USER_FILE]: `example.com ssh-ed25519 ${ed25519Base64}\r\nother.com ssh-rsa ${rsa.toString('base64')}\r\n` });

		expect(entries).toHaveLength(2);
		expect(entries[1].keyType).to.eql('ssh-rsa');
	});

	it('skips comments, blanks, @cert-authority and malformed lines', async () => {
		const { entries } = await load({
			[USER_FILE]: [
				'# a comment',
				'',
				`@cert-authority *.example.com ssh-rsa ${rsa.toString('base64')}`,
				'not-enough-fields',
				`example.com ssh-ed25519 ${ed25519Base64}`,
			].join('\n'),
		});

		expect(entries).toHaveLength(1);
		expect(entries[0].hostsPattern).to.eql('example.com');
	});

	it('keeps @revoked entries, flagged as revoked', async () => {
		const { entries } = await load({ [USER_FILE]: `@revoked example.com ssh-ed25519 ${ed25519Base64}\n` });

		expect(entries).toHaveLength(1);
		expect(entries[0].revoked).toBe(true);
		expect(entries[0].hostsPattern).to.eql('example.com');
	});

	it('reads multiple files and keeps user files first', async () => {
		vol.reset();
		vol.fromJSON({
			'/kh/first': `first.com ssh-ed25519 ${ed25519Base64}\n`,
			'/kh/second': `second.com ssh-ed25519 ${ed25519Base64}\n`,
		});

		// ssh-config's compute() returns multi-value directives as an array
		const knownHosts = await loadKnownHosts({ UserKnownHostsFile: ['/kh/first', '/kh/second'] }, logger);

		expect(knownHosts.entries.map(e => e.hostsPattern)).to.eql(['first.com', 'second.com']);
		expect(knownHosts.userFile).to.eql('/kh/first');
	});

	it('keeps a quoted path with spaces as one path', async () => {
		vol.reset();
		vol.fromJSON({ '/home/john smith/.ssh/known_hosts': `example.com ssh-ed25519 ${ed25519Base64}\n` });

		// A quoted value reaches us as a single string, quotes already stripped
		const knownHosts = await loadKnownHosts({ UserKnownHostsFile: '/home/john smith/.ssh/known_hosts' }, logger);

		expect(knownHosts.userFile).to.eql('/home/john smith/.ssh/known_hosts');
		expect(knownHosts.entries).toHaveLength(1);
	});

	it('treats the \'none\' keyword as no file', async () => {
		vol.reset();

		const knownHosts = await loadKnownHosts({ UserKnownHostsFile: 'none' }, logger);

		expect(knownHosts.userFile).toBeUndefined();
	});

	it('reports a file that exists but cannot be read', async () => {
		vol.reset();
		// A directory where a file is expected: exists, but readFile fails
		vol.fromJSON({ '/kh/known_hosts/placeholder': 'x' });

		const knownHosts = await loadKnownHosts({ UserKnownHostsFile: '/kh/known_hosts' }, logger);

		expect(knownHosts.entries).toHaveLength(0);
		expect(knownHosts.readFailures).to.eql(['/kh/known_hosts']);
	});

	it('survives a missing file', async () => {
		const knownHosts = await loadKnownHosts({ UserKnownHostsFile: '/does/not/exist' }, logger);

		expect(knownHosts.entries).toHaveLength(0);
		expect(knownHosts.userFile).to.eql('/does/not/exist');
		expect(knownHosts.readFailures).toHaveLength(0);
	});
});

describe('appendHostKey', () => {
	beforeEach(() => {
		vol.reset();
	});

	it('creates the directory and file on first use', async () => {
		await appendHostKey(USER_FILE, 'example.com', 22, 'ssh-ed25519', ed25519Base64);

		const content = vol.readFileSync(USER_FILE, 'utf8') as string;
		expect(content).to.eql(`example.com ssh-ed25519 ${ed25519Base64}\n`);
	});

	it('uses [host]:port for non-default ports', async () => {
		await appendHostKey(USER_FILE, 'example.com', 2222, 'ssh-ed25519', ed25519Base64);

		const content = vol.readFileSync(USER_FILE, 'utf8') as string;
		expect(content.startsWith('[example.com]:2222 ')).toBe(true);
	});

	it('appends to an existing file without a trailing newline', async () => {
		vol.fromJSON({ [USER_FILE]: `other.com ssh-rsa ${rsa.toString('base64')}` });

		await appendHostKey(USER_FILE, 'example.com', 22, 'ssh-ed25519', ed25519Base64);

		const lines = (vol.readFileSync(USER_FILE, 'utf8') as string).trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(lines[1]).to.eql(`example.com ssh-ed25519 ${ed25519Base64}`);
	});

	it('records the lowercased name, like OpenSSH', async () => {
		await appendHostKey(USER_FILE, 'Build01.Corp.Example', 22, 'ssh-ed25519', ed25519Base64);

		const content = vol.readFileSync(USER_FILE, 'utf8') as string;
		expect(content.startsWith('build01.corp.example ')).toBe(true);
	});

	it('records the HostKeyAlias verbatim when set', async () => {
		await appendHostKey(USER_FILE, 'localhost', 9922, 'ssh-ed25519', ed25519Base64, 'stage');

		const content = vol.readFileSync(USER_FILE, 'utf8') as string;
		expect(content.startsWith('stage ')).toBe(true);
	});
});

describe('replaceHostKey', () => {
	beforeEach(() => {
		vol.reset();
	});

	async function mismatchEntry(host: string, port = 22) {
		const { entries } = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		const verdict = matchHostKey(entries, host, port, 'ssh-ed25519', ed25519Base64);
		expect(verdict.status).to.eql('mismatch');
		return verdict.status === 'mismatch' ? verdict.entry : (undefined as never);
	}

	it('replaces the key in place and keeps other lines', async () => {
		vol.fromJSON({
			[USER_FILE]: [
				`other.com ssh-rsa ${rsa.toString('base64')}`,
				`example.com ssh-ed25519 ${otherEd25519.toString('base64')}`,
			].join('\n') + '\n',
		});

		const replaced = await replaceHostKey(await mismatchEntry('example.com'), 'example.com', 22, ed25519Base64);
		expect(replaced).toBe(true);

		const lines = (vol.readFileSync(USER_FILE, 'utf8') as string).trim().split('\n');
		expect(lines[0]).to.eql(`other.com ssh-rsa ${rsa.toString('base64')}`);
		expect(lines[1]).to.eql(`example.com ssh-ed25519 ${ed25519Base64}`);

		const reloaded = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		expect(matchHostKey(reloaded.entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
	});

	it('preserves a trailing comment on the line', async () => {
		vol.fromJSON({ [USER_FILE]: `example.com ssh-ed25519 ${otherEd25519.toString('base64')} deployed-by-ansible\n` });

		const replaced = await replaceHostKey(await mismatchEntry('example.com'), 'example.com', 22, ed25519Base64);
		expect(replaced).toBe(true);

		const content = (vol.readFileSync(USER_FILE, 'utf8') as string).trim();
		expect(content).to.eql(`example.com ssh-ed25519 ${ed25519Base64} deployed-by-ansible`);
	});

	it('replaces hashed entries, which denote a single name', async () => {
		vol.fromJSON({ [USER_FILE]: `${hashedPattern('example.com')} ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		const replaced = await replaceHostKey(await mismatchEntry('example.com'), 'example.com', 22, ed25519Base64);
		expect(replaced).toBe(true);
	});

	it('refuses to rewrite a multi-name line — that would re-pin the other hosts', async () => {
		const line = `web1.example.com,web2.example.com ssh-ed25519 ${otherEd25519.toString('base64')}`;
		vol.fromJSON({ [USER_FILE]: `${line}\n` });

		const replaced = await replaceHostKey(await mismatchEntry('web1.example.com'), 'web1.example.com', 22, ed25519Base64);

		expect(replaced).toBe(false);
		expect((vol.readFileSync(USER_FILE, 'utf8') as string).trim()).to.eql(line);
	});

	it('refuses to rewrite a wildcard line', async () => {
		const line = `*.example.com ssh-ed25519 ${otherEd25519.toString('base64')}`;
		vol.fromJSON({ [USER_FILE]: `${line}\n` });

		const replaced = await replaceHostKey(await mismatchEntry('web1.example.com'), 'web1.example.com', 22, ed25519Base64);

		expect(replaced).toBe(false);
		expect((vol.readFileSync(USER_FILE, 'utf8') as string).trim()).to.eql(line);
	});

	it('appending next to a wildcard line leaves the old key trusted — which is why it is refused', async () => {
		vol.fromJSON({ [USER_FILE]: `*.example.com ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		await appendHostKey(USER_FILE, 'web1.example.com', 22, 'ssh-ed25519', ed25519Base64);

		const { entries } = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		// The new key verifies...
		expect(matchHostKey(entries, 'web1.example.com', 22, 'ssh-ed25519', ed25519Base64).status).to.eql('match');
		// ...but so does the OLD one: appending doesn't retire it. Hence
		// findConflictingEntries reports it and the caller refuses.
		expect(matchHostKey(entries, 'web1.example.com', 22, 'ssh-ed25519', otherEd25519.toString('base64')).status).to.eql('match');
		expect(findConflictingEntries(entries, 'web1.example.com', 22, 'ssh-ed25519', ed25519Base64)).toHaveLength(1);
	});

	it('leaves the file alone if the line changed underneath', async () => {
		vol.fromJSON({ [USER_FILE]: `example.com ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		const { entries } = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		const entry = entries[0];

		// Simulate the file being rewritten between load and replace
		vol.writeFileSync(USER_FILE, `something.else ssh-rsa ${rsa.toString('base64')}\n`);

		const replaced = await replaceHostKey(entry, 'example.com', 22, ed25519Base64);

		expect(replaced).toBe(false);
		expect(vol.readFileSync(USER_FILE, 'utf8') as string).to.eql(`something.else ssh-rsa ${rsa.toString('base64')}\n`);
	});
});

describe('removeHostFromEntry', () => {
	beforeEach(() => {
		vol.reset();
	});

	async function entryFor(host: string) {
		const { entries } = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		return entries.find(e => matchHostKey([e], host, 22, 'ssh-ed25519', 'x').status !== 'unknown')!;
	}

	it('drops just this host from a multi-name line, keeping the key for the others', async () => {
		vol.fromJSON({ [USER_FILE]: `web1.example.com,web2.example.com ssh-ed25519 ${otherEd25519.toString('base64')}\n` });

		expect(await removeHostFromEntry(await entryFor('web1.example.com'), 'web1.example.com', 22)).toBe(true);

		const { entries } = await loadKnownHosts({ UserKnownHostsFile: USER_FILE }, logger);
		expect(entries[0].hostsPattern).to.eql('web2.example.com');
		expect(matchHostKey(entries, 'web1.example.com', 22, 'ssh-ed25519', otherEd25519.toString('base64')).status).to.eql('unknown');
		expect(matchHostKey(entries, 'web2.example.com', 22, 'ssh-ed25519', otherEd25519.toString('base64')).status).to.eql('match');
	});

	it('deletes the line when this host was its only name', async () => {
		vol.fromJSON({ [USER_FILE]: `only.example.com ssh-ed25519 ${otherEd25519.toString('base64')}\nkeep.example.com ssh-rsa ${rsa.toString('base64')}\n` });

		expect(await removeHostFromEntry(await entryFor('only.example.com'), 'only.example.com', 22)).toBe(true);

		const content = (vol.readFileSync(USER_FILE, 'utf8') as string).trim();
		expect(content).to.eql(`keep.example.com ssh-rsa ${rsa.toString('base64')}`);
	});

	it('refuses a line with a wildcard, which could still match afterwards', async () => {
		const line = `web1.example.com,*.example.com ssh-ed25519 ${otherEd25519.toString('base64')}`;
		vol.fromJSON({ [USER_FILE]: `${line}\n` });

		expect(await removeHostFromEntry(await entryFor('web1.example.com'), 'web1.example.com', 22)).toBe(false);
		expect((vol.readFileSync(USER_FILE, 'utf8') as string).trim()).to.eql(line);
	});
});

describe('findConflictingEntries', () => {
	beforeEach(() => {
		vol.reset();
	});

	it('finds every same-type entry pinning a different key, and ignores the rest', async () => {
		const { entries } = await load({
			[USER_FILE]: [
				`example.com ssh-ed25519 ${otherEd25519.toString('base64')}`,   // conflict
				`example.com ssh-rsa ${rsa.toString('base64')}`,                // other type
				`other.com ssh-ed25519 ${otherEd25519.toString('base64')}`,     // other host
				`@revoked example.com ssh-ed25519 ${otherEd25519.toString('base64')}`, // revoked
				`example.com ssh-ed25519 ${ed25519Base64}`,                     // the new key itself
			].join('\n'),
		});

		const conflicts = findConflictingEntries(entries, 'example.com', 22, 'ssh-ed25519', ed25519Base64);

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].line).to.eql(0);
	});
});
