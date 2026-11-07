import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function checkStartup(scenario: 'delayed' | 'missing' | 'empty' | 'library') {
    let  source = readFileSync('src/scripts/server-setup.sh', 'utf8');
    source = source.replace('waitUntil=$((SECONDS+20))', 'waitUntil=$((SECONDS+1))');
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

        // Replace only the clock and result callback. The real readiness code
        // sees a missing log, then an empty log, then the listening address.
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
print_install_results() {
    printf 'result=%s ticks=%s listening=%s\\n' "$1" "$ticks" "$LISTENING_ON"
    exit "$1"
}

fail_and_exit() {
  print_install_results "$1"
  exit 0
}
`;
        const result = spawnSync('bash', ['-c', stub + readiness], {
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
        return { status: result.status, output: result.stdout, logExists: existsSync(logfile) };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe.skipIf(process.platform === 'win32')('server startup readiness', () => {
    it('waits for log creation and then for the listening address', () => {
        const result = checkStartup('delayed');
        expect(result.status).toBe(0);
        expect(result.output).toContain('result=0 ticks=2 listening=45707');
    });

    it('reports a missing log only after the startup deadline', () => {
        const result = checkStartup('missing');
        expect(result.status).toBe(1);
        expect(result.output).toContain('Error: server log file not found');
        expect(result.logExists).toBe(false);
    });

    it('distinguishes an existing log without readiness from a missing log', () => {
        const result = checkStartup('empty');
        expect(result.status).toBe(1);
        expect(result.output).toContain('Error: server did not start successfully');
        expect(result.logExists).toBe(true);
    });

    it('reports a known library failure without waiting for the deadline', () => {
        const result = checkStartup('library');
        expect(result.status).toBe(1);
        expect(result.output).toContain('Error: missing libstdc++');
        expect(result.output).toContain('result=1 ticks=0 listening=');
    });
});
