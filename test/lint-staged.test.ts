import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

// Native ESM keeps this tied to the installed matcher, not a reimplemented glob.
const nativeSetup = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(path.join(process.env.TOOLING_ROOT, 'package.json'));
const packagePath = require.resolve('lint-staged/package.json');
const lintStagedRequire = createRequire(packagePath);
const { parse } = lintStagedRequire('yaml');
const config = parse(readFileSync(path.join(process.env.TOOLING_ROOT, '.lintstagedrc.yml'), 'utf8'));
const internal = (name) => import(pathToFileURL(path.join(path.dirname(packagePath), 'lib', name)).href);
const { generateTasks } = await internal('generateTasks.js');
const files = JSON.parse(process.env.STAGED_FILES).map((file) => ({
    filepath: path.resolve(file), status: 'M',
}));
const tasks = generateTasks({ config, cwd: process.cwd(), files });
`;

function native(script: string, files: string[], env: NodeJS.ProcessEnv = {}, cwd = root, timeout = 15000) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', nativeSetup + script], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env, TOOLING_ROOT: root, STAGED_FILES: JSON.stringify(files) },
        timeout,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return result.stdout;
}

function findExecutable(name: string): string | null {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        const candidate = path.join(directory, name);
        try {
            accessSync(candidate, constants.X_OK);
            return realpathSync(candidate);
        } catch {
            // Continue searching; a miss only demotes this prerequisite to optional.
        }
    }
    return null;
}

const pipxPath = findExecutable('pipx');
const python3Path = findExecutable('python3');

// The real-acquisition test needs PyPI once; an unreachable index is an
// environment gap to report, not a security-assertion failure.
async function pypiReachable(): Promise<boolean> {
    try {
        const response = await fetch('https://pypi.org/simple/', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        return response.ok;
    } catch {
        return false;
    }
}

function runTask(pattern: string, files: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 15000): {
    failed: boolean; exitCode: number; output: string; files: string[];
} {
    return JSON.parse(native(`
const task = tasks.find((task) => task.pattern === ${JSON.stringify(pattern)});
const { getSpawnedTask } = await internal('getSpawnedTask.js');
const { getInitialState } = await internal('state.js');
const ctx = getInitialState();
let failed = false;
let exitCode = 0;
try {
    await getSpawnedTask({
        abortController: new AbortController(), command: task.commands,
        cwd: process.cwd(), topLevelDir: process.cwd(), isFn: false, verbose: true,
        files: task.fileList.map((file) => file.filepath),
    })(ctx);
} catch (error) {
    failed = true;
    exitCode = error.cause?.exitCode ?? null;
}
console.log(JSON.stringify({ failed, exitCode, output: ctx.output.join('\\n'), files: task.fileList.map((file) => file.filepath) }));
`, files, env, cwd, timeout));
}

interface Task {
    pattern: string;
    commands: string | string[];
    fileList: { filepath: string; status: string }[];
}

describe('staged tooling', () => {
    it('sends root and nested TypeScript, but not unrelated files, to ESLint', () => {
        const tasks: Task[] = JSON.parse(native('console.log(JSON.stringify(tasks));', [
            'root.ts', 'src/tmux/nested.ts', 'src/notes.md', 'README.md', '.github/workflows/check.yml',
        ]));
        const eslint = tasks.find(task => task.pattern === '*.ts');
        expect(eslint?.commands).toBe('eslint');
        expect(eslint?.fileList.map(file => file.filepath)).toEqual([
            path.resolve(root, 'root.ts'), path.resolve(root, 'src/tmux/nested.ts'),
        ]);
        expect(tasks.find(task => task.pattern === './package.json')?.commands).toEqual(['fixpack']);
    });

    it('keeps standalone workflow lint and fix scripts on the same acquisition path', () => {
        const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(manifest.scripts['ci:lint']).toBe('pipx run zizmor .');
        expect(manifest.scripts['ci:lint:fix']).toBe('pipx run zizmor . --fix=all');
    });

    it.each([0, 17])('appends workflow paths and propagates stubbed pipx status %i', (status) => {
        const directory = mkdtempSync(path.join(tmpdir(), 'staged-workflow-'));
        try {
            const argumentsFile = path.join(directory, 'arguments');
            writeFileSync(path.join(directory, 'pipx'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENTS_FILE"\nexit "$CHECKER_STATUS"\n', { mode: 0o755 });
            const output = native(`
const task = tasks.find((task) => task.pattern === '.github/workflows/*.yml');
const { getSpawnedTask } = await internal('getSpawnedTask.js');
let failed = false;
try {
    await getSpawnedTask({
        abortController: new AbortController(), command: task.commands,
        cwd: process.cwd(), topLevelDir: process.cwd(), isFn: false,
        files: task.fileList.map((file) => file.filepath),
    })();
} catch {
    failed = true;
}
console.log(JSON.stringify({ command: task.commands, failed }));
`, ['.github/workflows/ci-pr.yml', '.github/workflows/ci-main.yml', 'docs/unrelated.yml'], {
                PATH: `${directory}${path.delimiter}${process.env.PATH}`,
                ARGUMENTS_FILE: argumentsFile,
                CHECKER_STATUS: String(status),
            });
            expect(JSON.parse(output)).toEqual({ command: 'pipx run zizmor', failed: status !== 0 });
            expect(readFileSync(argumentsFile, 'utf8').trim().split('\n')).toEqual([
                'run', 'zizmor', path.resolve(root, '.github/workflows/ci-pr.yml'),
                path.resolve(root, '.github/workflows/ci-main.yml'),
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('runs real ESLint through the staged task runner on nested TypeScript fixtures', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'staged-eslint-'));
        try {
            mkdirSync(path.join(directory, 'src/tmux'), { recursive: true });
            writeFileSync(path.join(directory, 'eslint.config.mjs'),
                `export { default } from ${JSON.stringify(pathToFileURL(path.join(root, 'eslint.config.mjs')).href)};\n`);
            const env = { PATH: `${path.join(root, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}` };
            for (const [source, status] of [['export const answer = 42;\n', 0], ['export const answer: any = 42;\n', 1]] as const) {
                writeFileSync(path.join(directory, 'src/tmux/probe.ts'), source);
                const result = runTask('*.ts', ['src/tmux/probe.ts'], directory, env);
                expect(result.files).toEqual([path.join(directory, 'src/tmux/probe.ts')]);
                expect(result.exitCode, result.output).toBe(status);
                expect(result.failed, result.output).toBe(status !== 0);
                if (status !== 0) {
                    expect(result.output).toContain('@typescript-eslint/no-explicit-any');
                }
            }
            console.info(`Real ESLint ${JSON.parse(readFileSync(path.join(root, 'node_modules/eslint/package.json'), 'utf8')).version}: staged nested valid exit=0; no-explicit-any exit=1`);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 45000);

    it('acquires real zizmor with pipx and propagates an actual unsafe-workflow finding', async (ctx) => {
        const pipx = pipxPath;
        const python3 = python3Path;
        const pypi = pipx !== null && python3 !== null ? await pypiReachable() : null;
        if (pipx === null || python3 === null || pypi !== true) {
            const missing = [
                pipx === null ? 'pipx on PATH' : null,
                python3 === null ? 'python3 on PATH' : null,
                pypi === false ? 'network access to https://pypi.org/simple/' : null,
            ].filter((piece): piece is string => piece !== null);
            console.info(`Skipped real zizmor acquisition — environment lacks: ${missing.join(', ')}`);
            ctx.skip();
            return;
        }
        const directory = mkdtempSync(path.join(tmpdir(), 'staged-zizmor-'));
        try {
            const bin = path.join(directory, 'bin');
            mkdirSync(bin);
            // Only these real prerequisites are exposed: no global zizmor on PATH.
            symlinkSync(pipx, path.join(bin, 'pipx'));
            symlinkSync(python3, path.join(bin, 'python3'));
            const env = {
                PATH: bin,
                PIPX_HOME: path.join(directory, 'pipx'),
                PIPX_BIN_DIR: path.join(directory, 'apps'),
                PIPX_MAN_DIR: path.join(directory, 'man'),
                PIPX_DEFAULT_PYTHON: python3,
                XDG_CACHE_HOME: path.join(directory, 'cache'),
                PIP_CACHE_DIR: path.join(directory, 'pip-cache'),
                PIPX_USE_UV: '0',
                NO_COLOR: '1',
            };
            const version = (command: string, args: string[]) => {
                const result = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
                expect(result.error, result.stderr).toBeUndefined();
                expect(result.status, result.stdout + result.stderr).toBe(0);
                return result.stdout.trim();
            };
            console.info(`Prerequisites: Node ${process.version}; Python ${version('python3', ['--version'])}; pipx ${version('pipx', ['--version'])}`);
            // This cold-cache call must acquire the package, not find a global binary.
            console.info(`Acquired: ${version('pipx', ['run', 'zizmor', '--version'])}; version exit=0`);
            const workflows = path.join(directory, '.github/workflows');
            mkdirSync(workflows, { recursive: true });
            const workflow = (run: string) => `name: probe\non: issues\npermissions: {}\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
            for (const [name, run, valid] of [
                ['valid', 'echo safe', true],
                ['unsafe', 'echo "${{ github.event.issue.title }}"', false],
            ] as const) {
                const file = `.github/workflows/${name}.yml`;
                writeFileSync(path.join(directory, file), workflow(run));
                const result = runTask('.github/workflows/*.yml', [file], directory, env, 120000);
                expect(result.files).toEqual([path.join(directory, file)]);
                expect(result.failed, result.output).toBe(!valid);
                if (valid) {
                    expect(result.exitCode, result.output).toBe(0);
                } else {
                    expect(result.exitCode, result.output).toBeGreaterThan(0);
                    expect(result.output).toContain('template-injection');
                    expect(result.output).toContain('unsafe.yml');
                }
                console.info(`Real zizmor ${name}: exit=${result.exitCode}; task failed=${result.failed}\n${result.output}`);
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 360000);

    it('fails loudly when pipx is absent from the staged task PATH', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'staged-nopipx-'));
        try {
            const bin = path.join(directory, 'bin');
            mkdirSync(bin);
            mkdirSync(path.join(directory, '.github/workflows'), { recursive: true });
            const file = '.github/workflows/probe.yml';
            writeFileSync(path.join(directory, file),
                'name: probe\non: issues\npermissions: {}\njobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n');
            const result = runTask('.github/workflows/*.yml', [file], directory, { PATH: bin });
            expect(result.files).toEqual([path.join(directory, file)]);
            expect(result.failed, result.output).toBe(true);
            expect(result.exitCode, result.output).not.toBe(0);
            expect(result.output).toContain('Task failed to spawn');
            console.info(`No-pipx guard: staged workflow task failed (exitCode=${result.exitCode}) with only an empty bin/ on PATH`);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it.each([0, 23])('propagates stubbed checker exit %i under Husky-equivalent sh -e', (status) => {
        const directory = mkdtempSync(path.join(tmpdir(), 'staged-hook-'));
        try {
            const calls = path.join(directory, 'calls');
            writeFileSync(path.join(directory, 'npx'), '#!/bin/sh\nprintf "npx %s\\n" "$*" >> "$CALLS"\nexit "$CHECKER_STATUS"\n', { mode: 0o755 });
            writeFileSync(path.join(directory, 'npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
            const result = spawnSync('sh', ['-e', path.join(root, '.husky/pre-commit')], {
                cwd: root,
                encoding: 'utf8',
                env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, CALLS: calls, CHECKER_STATUS: String(status) },
                timeout: 15000,
            });
            expect(result.error).toBeUndefined();
            expect(result.status, result.stdout + result.stderr).toBe(status);
            expect(readFileSync(calls, 'utf8')).toBe(status === 0
                ? 'npx lint-staged\nnpm run compile:src\nnpm test\n'
                : 'npx lint-staged\n');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
