import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parsePrompt,
    AUTH_CONFIRMED_RE,
    LineParser,
    CommandRunner,
} from '../src/native/nativeSshParser';

describe('parsePrompt', () => {
    it.each([
        ['Are you sure you want to continue connecting (yes/no)? ', 'host-key-confirm'],
        ['Are you sure you want to continue connecting (yes/no/[fingerprint])? ', 'host-key-confirm-fp'],
        ['Please type \'yes\' or \'no\': ', 'host-key-retry'],
        ['Please type \'yes\', \'no\' or the fingerprint: ', 'host-key-retry-fp'],
        ['user@host\'s password: ', 'entry'],
        ['Enter passphrase for key \'/home/u/.ssh/id_rsa\': ', 'entry'],
        ['Password: ', 'entry'],
        ['Welcome to Ubuntu 22.04 LTS', 'entry'],
    ] as const)('classifies %j as %s', (input, expected) => {
        expect(parsePrompt(input).kind).toBe(expected);
    });

    // Load-bearing: the -fp patterns must come before the generic ones.
    it('prefers the fingerprint variant over the generic variant', () => {
        expect(parsePrompt('Please type \'yes\', \'no\' or the fingerprint: ').kind)
            .toBe('host-key-retry-fp');
        expect(parsePrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])?').kind)
            .toBe('host-key-confirm-fp');
    });

    it('returns the prompt verbatim as the message', () => {
        const input = 'user@host\'s password: ';
        expect(parsePrompt(input).message).toBe(input);
    });
});

describe('AUTH_CONFIRMED_RE', () => {
    it.each([
        // Pre-8.7
        ['debug1: Authentication succeeded (publickey).', true],
        // 8.7+
        ['Authenticated to host ([10.0.0.1]:22) using "publickey".', true],
        ['Authenticated to host ([::1]:22) using "none".', true],
        // Non-matches
        ['Authenticated to host ([10.0.0.1]:22).', false],
        ['Permission denied (publickey,password).', false],
        ['debug1: SSH2_MSG_SERVICE_ACCEPT received', false],
    ])('%j → %s', (line, expected) => {
        expect(AUTH_CONFIRMED_RE.test(line)).toBe(expected);
    });
});

describe('LineParser', () => {
    it('buffers a partial line across chunks', () => {
        const lines: string[] = [];
        const parser = new LineParser({ onLine: (l) => lines.push(l) });
        parser.push('foo');
        parser.push('bar\n');
        expect(lines).toEqual(['foobar']);
    });

    it('strips CR from CRLF line endings', () => {
        const lines: string[] = [];
        const parser = new LineParser({ onLine: (l) => lines.push(l) });
        parser.push('a\r\nb\r\n');
        expect(lines).toEqual(['a', 'b']);
    });

    it('flushes a partial line on end()', () => {
        const lines: string[] = [];
        const flushes: string[] = [];
        const errors: string[] = [];
        const parser = new LineParser({
            onLine: (l) => lines.push(l),
            onFlush: (l) => flushes.push(l),
            onError: (r) => errors.push(r),
        });
        parser.push('incomplete');
        parser.end('closed');
        expect(flushes).toEqual(['incomplete']);
        expect(errors).toEqual(['closed']);
    });

    it('ignores pushes after end()', () => {
        const lines: string[] = [];
        const parser = new LineParser({ onLine: (l) => lines.push(l) });
        parser.end();
        parser.push('ignored\n');
        expect(lines).toEqual([]);
    });

    it('subscription.dispose stops delivery', () => {
        const parser = new LineParser();
        const a: string[] = [];
        const b: string[] = [];
        parser.subscribe({ onLine: (l) => a.push(l) });
        const subB = parser.subscribe({ onLine: (l) => b.push(l) });
        parser.push('1\n');
        subB.dispose();
        parser.push('2\n');
        expect(a).toEqual(['1', '2']);
        expect(b).toEqual(['1']);
    });
});

describe('CommandRunner', () => {
    let stdout: LineParser;
    let stderr: LineParser;
    let write: ReturnType<typeof vi.fn>;
    let runner: CommandRunner;

    beforeEach(() => {
        stdout = new LineParser();
        stderr = new LineParser();
        write = vi.fn().mockResolvedValue(undefined);
        runner = new CommandRunner(stdout, stderr, write as unknown as (d: string) => Promise<void>);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes the command and resolves with the predicate value', async () => {
        const promise = runner.run('ls\n', (s) => (s === 'done' ? 'ok' : undefined));
        expect(write).toHaveBeenCalledWith('ls\n');
        stdout.push('done\n');
        await expect(promise).resolves.toBe('ok');
    });

    it('rejects when write() fails', async () => {
        write.mockRejectedValueOnce(new Error('EPIPE'));
        await expect(runner.run('cmd\n', () => undefined)).rejects.toThrow('EPIPE');
    });

    it('rejects when a parser ends before a match', async () => {
        const promise = runner.run('cmd\n', () => undefined);
        stdout.end('helper closed');
        await expect(promise).rejects.toThrow(/helper closed/);
    });

    it('rejects after timeoutMs', async () => {
        vi.useFakeTimers();
        const promise = runner.run('cmd\n', () => undefined, 5_000);
        const settled = promise.catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(5_000);
        const err = await settled;
        expect((err as Error).message).toMatch(/timed out after 5000ms/);
    });

    it('disposes subscriptions on resolution', async () => {
        const promise = runner.run('cmd\n', (s) => (s === 'hit' ? true : undefined));
        stdout.push('hit\n');
        await promise;
        // If the runner leaked its subscription, a subsequent end() would
        // try to reject an already-settled promise — this must not throw.
        expect(() => stdout.end()).not.toThrow();
    });
});
