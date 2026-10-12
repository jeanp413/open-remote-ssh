import { spawnSync } from 'child_process';

export function runDocker(args: string[], allowFailure = false): string {
    // console.log(`docker ${args.join(' ')}`);

    const result = spawnSync('docker', args, { encoding: 'utf8' });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0 && !allowFailure) {
        throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }

    return (result.stdout || '').trim();
}
