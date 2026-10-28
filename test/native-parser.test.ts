import { expect, it } from 'vitest';
import { CommandRunner, LineParser } from '../src/native/nativeSshParser';

it('keeps stdout and stderr separate in command predicates', async () => {
    const stdout = new LineParser();
    const stderr = new LineParser();
    const runner = new CommandRunner(stdout, stderr, async () => {
        stdout.push('output\n');
        stderr.push('diagnostic\n');
    });
    const lines: [string | undefined, string | undefined][] = [];

    const result = await runner.run('test', (out, err) => {
        lines.push([out, err]);
        return lines.length === 2 ? lines : undefined;
    });

    expect(result).toEqual([['output', undefined], [undefined, 'diagnostic']]);
});
