import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function checkStartup(scenario: 'delayed' | 'missing' | 'empty' | 'library') {
    const source = readFileSync('src/scripts/server-setup.sh', 'utf8')
        .replace('waitUntil=$((SECONDS+20))', 'waitUntil=$((SECONDS+1))');
    const callbacks = source.slice(source.indexOf('print_install_results() {'), source.indexOf('# Validate the commit'))
        .replace('%%ENV_VAR_LINES%%', '');
    const starts = [...source.matchAll(/^if \[\[ -f \$SERVER_TOKENFILE \]\]; then$/gm)];
    expect(starts).toHaveLength(1);
    const readiness = source.slice(starts[0].index);
    const directory = mkdtempSync(join(tmpdir(), 'open-remote-ssh-startup-'));
    const logfile = join(directory, 'server.log');
    const tokenfile = join(directory, 'server.token');

    try {
        writeFileSync(tokenfile, 'test-token\n');
        if (scenario === 'empty') {
            writeFileSync(logfile, '');
        } else if (scenario === 'library') {
            writeFileSync(logfile, 'Error loading shared library libstdc++.so\n');
        }

        // Keep the real result callbacks so failure paths must terminate setup.
        // Simulate the log appearing while the readiness loop waits.
        const stub = `
SCRIPT_PREVENT_EXIT=0
LISTENING_ON=
ticks=0
sleep() {
    ticks=$((ticks + 1))
    if [[ $SCENARIO = delayed ]]; then
        case "$ticks" in
            1) : > "$SERVER_LOGFILE" ;;
            2) printf 'Extension host agent listening on 45707\\n' > "$SERVER_LOGFILE" ;;
        esac
    fi
    return 0
}
`;
        const result = spawnSync('bash', ['-c', stub + callbacks + readiness + '\nprintf "ticks=%s\\n" "$ticks"'], {
            encoding: 'utf8',
            timeout: 10000,
            env: {
                ...process.env,
                SCENARIO: scenario,
                SERVER_LOGFILE: logfile,
                SERVER_TOKENFILE: tokenfile,
            },
        });
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.stdout.match(/^exitCode==[01]==$/gm)).toEqual([
            scenario === 'delayed' ? 'exitCode==0==' : 'exitCode==1=='
        ]);
        return { status: result.status, output: result.stdout, logExists: existsSync(logfile) };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe.skipIf(process.platform === 'win32')('server startup readiness', () => {
    it('waits for log creation and then for the listening address', () => {
        const result = checkStartup('delayed');
        expect(result.status).toBe(0);
        expect(result.output).toContain('listeningOn==45707==');
        expect(result.output).toContain('ticks=2');
    });

    it('reports a missing log only after the startup deadline', () => {
        const result = checkStartup('missing');
        expect(result.status).toBe(0);
        expect(result.output).toContain('Error: server log file not found');
        expect(result.logExists).toBe(false);
    });

    it('distinguishes an existing log without readiness from a missing log', () => {
        const result = checkStartup('empty');
        expect(result.status).toBe(0);
        expect(result.output).toContain('Error: server did not start successfully');
        expect(result.logExists).toBe(true);
    });

    it('reports a known library failure without waiting for the deadline', () => {
        const result = checkStartup('library');
        expect(result.status).toBe(0);
        expect(result.output).toContain('Error: missing libstdc++');
        expect(result.output).not.toContain('ticks=');
    });
});
