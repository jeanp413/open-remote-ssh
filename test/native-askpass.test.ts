import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { AskPassServer } from '../src/native/nativeSshAskpass';
import { window } from './mocks/vscode';

it.each([
    { hint: 'none', prompt: 'Confirm user presence for key ED25519-SK SHA256:test', answer: '' },
    { hint: undefined, prompt: 'Enter PIN for ED25519-SK key: ', answer: '1234' },
])('handles askpass hint $hint without waiting for notification dismissal', async ({ hint, prompt, answer }) => {
    const dir = await mkdtemp(join(tmpdir(), 'open-remote-ssh-askpass-'));
    const script = join(dir, 'askpass-node.js');
    const output = join(dir, 'answer');
    const source = await readFile('src/native/askpass/askpass-node.ts', 'utf8');
    await writeFile(script, ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    const info = vi.spyOn(window, 'showInformationMessage').mockClear().mockReturnValue(new Promise<undefined>(() => {}));
    const input = vi.spyOn(window, 'showInputBox').mockResolvedValue('1234');
    const server = await AskPassServer.create();
    try {
        await promisify(execFile)(process.execPath, [script, prompt], {
            timeout: 2000, killSignal: 'SIGKILL',
            env: {
                ...process.env,
                SSH_ASKPASS_PROMPT: hint,
                NATIVE_SSH_ASKPASS_SOCKET: server.socketPath,
                NATIVE_SSH_ASKPASS_FILE: output,
            },
        });
        expect(await readFile(output, 'utf8')).toBe(answer + '\n');
        expect(info).toHaveBeenCalledTimes(hint === 'none' ? 1 : 0);
        expect(input).toHaveBeenCalledTimes(hint === 'none' ? 0 : 1);
        if (hint === 'none') {
            expect(info).toHaveBeenCalledWith(prompt);
        }
    } finally {
        await server.dispose();
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
    }
});
