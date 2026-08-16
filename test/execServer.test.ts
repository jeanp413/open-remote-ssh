import { FileType } from 'vscode';
import { describe, expect, it } from 'vitest';
import { shellEscapeArg, shellEscaped, getFileType } from '../src/execServer';

describe('shellEscapeArg', () => {
	it('wraps simple string in single quotes', () => {
		expect(shellEscapeArg('hello')).toBe("'hello'");
	});

	it('escapes single quotes', () => {
		expect(shellEscapeArg("it's")).toBe("'it'\\''s'");
	});

	it('handles empty string', () => {
		expect(shellEscapeArg('')).toBe("''");
	});

	it('handles multiple single quotes', () => {
		expect(shellEscapeArg("a'b'c")).toBe("'a'\\''b'\\''c'");
	});

	it('preserves spaces and special chars inside quotes', () => {
		expect(shellEscapeArg('hello world')).toBe("'hello world'");
		expect(shellEscapeArg('$HOME')).toBe("'$HOME'");
		expect(shellEscapeArg('a;rm -rf /')).toBe("'a;rm -rf /'");
		expect(shellEscapeArg('`whoami`')).toBe("'`whoami`'");
	});
});

describe('shellEscaped', () => {
	it('escapes command and args', () => {
		expect(shellEscaped('ls', ['-la', '/tmp'])).toBe("'ls' '-la' '/tmp'");
	});

	it('prepends cwd', () => {
		expect(shellEscaped('ls', [], { cwd: '/home/user' })).toBe("cd '/home/user' && 'ls'");
	});

	it('prepends env vars', () => {
		expect(shellEscaped('node', ['app.js'], { env: { FOO: 'bar', BAZ: 'qux' } }))
			.toBe("FOO='bar' BAZ='qux' 'node' 'app.js'");
	});

	it('env: ordered after cd but before cmd', () => {
		const result = shellEscaped('run', [], { cwd: '/app', env: { X: '1' } });
		expect(result).toBe("cd '/app' && X='1' 'run'");
	});

	it('env: escapes values but not keys', () => {
		expect(shellEscaped('cmd', [], { env: { PATH: "/usr/bin:/bin" } }))
			.toBe("PATH='/usr/bin:/bin' 'cmd'");
	});

	it('env: rejects invalid keys', () => {
		expect(() => shellEscaped('cmd', [], { env: { 'bad key': 'v' } })).toThrow('Bad env key');
		expect(() => shellEscaped('cmd', [], { env: { '1start': 'v' } })).toThrow('Bad env key');
		expect(() => shellEscaped('cmd', [], { env: { 'a;b': 'v' } })).toThrow('Bad env key');
		expect(() => shellEscaped('cmd', [], { env: { '': 'v' } })).toThrow('Bad env key');
	});

	it('env: accepts valid keys', () => {
		expect(() => shellEscaped('cmd', [], { env: { _FOO: 'v' } })).not.toThrow();
		expect(() => shellEscaped('cmd', [], { env: { A_B_C: 'v' } })).not.toThrow();
		expect(() => shellEscaped('cmd', [], { env: { x1: 'v' } })).not.toThrow();
	});
});

describe('getFileType', () => {
	it('identifies regular files', () => {
		expect(getFileType(0o100644)).toBe(FileType.File);
		expect(getFileType(0o100755)).toBe(FileType.File);
	});

	it('identifies directories', () => {
		expect(getFileType(0o040755)).toBe(FileType.Directory);
	});

	it('identifies symbolic links', () => {
		expect(getFileType(0o120777)).toBe(FileType.SymbolicLink);
	});

	it('does not misclassify regular files as symlinks', () => {
		expect(getFileType(0o100644)).not.toBe(FileType.SymbolicLink);
	});

	it('returns Unknown for other types', () => {
		expect(getFileType(0o060660)).toBe(FileType.Unknown); // block device
		expect(getFileType(0o020666)).toBe(FileType.Unknown); // char device
		expect(getFileType(0o010644)).toBe(FileType.Unknown); // fifo
		expect(getFileType(0o140755)).toBe(FileType.Unknown); // socket
	});
});
