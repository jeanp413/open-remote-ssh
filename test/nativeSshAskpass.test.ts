import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
    window: {
        showInputBox: vi.fn(),
        showQuickPick: vi.fn(),
    },
}));

vi.mock('../src/native/nativeSshConnection', () => ({
    getNativeSshSocketPath: vi.fn((label: string) =>
        `${process.env.TMPDIR ?? '/tmp'}/open-remote-ssh-${label}-${Math.random().toString(16).slice(2)}.sock`,
    ),
}));

import * as vscode from 'vscode';
import * as http from 'http';
import { AskPassServer } from '../src/native/nativeSshAskpass';
import { Log } from './mocks/logger';

const mockedVscode = vscode as unknown as {
    window: {
        showInputBox: ReturnType<typeof vi.fn>;
        showQuickPick: ReturnType<typeof vi.fn>;
    };
};

interface PromptResponse {
    response?: string;
    cancelled?: boolean;
}

function postPrompt(socketPath: string, prompt: string): Promise<{ statusCode: number | undefined; body: string }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ prompt });
        const request = http.request(
            {
                socketPath,
                path: '/prompt',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                },
            },
            (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (c: string) => { body += c; });
                response.on('end', () => resolve({ statusCode: response.statusCode, body }));
            },
        );
        request.on('error', reject);
        request.write(payload);
        request.end();
    });
}

describe('AskPassServer', () => {
    let server: AskPassServer;

    beforeEach(async () => {
        mockedVscode.window.showInputBox.mockReset();
        mockedVscode.window.showQuickPick.mockReset();
        server = await AskPassServer.create(new Log('Test AskPassServer'));
    });

    it('routes an entry prompt through showInputBox', async () => {
        mockedVscode.window.showInputBox.mockResolvedValue('hunter2');
        const res = await postPrompt(server.socketPath, 'user@host\'s password: ');
        const parsed = JSON.parse(res.body) as PromptResponse;
        expect(res.statusCode).toBe(200);
        expect(parsed.response).toBe('hunter2');
        expect(parsed.cancelled).toBe(false);
        expect(mockedVscode.window.showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({ password: true }),
        );
    });

    it('routes a host-key confirmation through showQuickPick', async () => {
        mockedVscode.window.showQuickPick.mockResolvedValue('yes');
        const res = await postPrompt(
            server.socketPath,
            'Are you sure you want to continue connecting (yes/no)? ',
        );
        const parsed = JSON.parse(res.body) as PromptResponse;
        expect(parsed.response).toBe('yes');
        expect(mockedVscode.window.showQuickPick).toHaveBeenCalled();
    });

    it('offers the fingerprint option on fingerprint-variant confirm', async () => {
        mockedVscode.window.showQuickPick.mockResolvedValue('Enter fingerprint…');
        mockedVscode.window.showInputBox.mockResolvedValue('SHA256:abc');
        const res = await postPrompt(
            server.socketPath,
            'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
        );
        const parsed = JSON.parse(res.body) as PromptResponse;
        expect(parsed.response).toBe('SHA256:abc');
        const choices = mockedVscode.window.showQuickPick.mock.calls[0][0] as string[];
        expect(choices).toContain('Enter fingerprint…');
    });

    it('reports cancellation when the user dismisses the input box', async () => {
        mockedVscode.window.showInputBox.mockResolvedValue(undefined);
        const res = await postPrompt(server.socketPath, 'user@host\'s password: ');
        const parsed = JSON.parse(res.body) as PromptResponse;
        expect(parsed.cancelled).toBe(true);
        expect(parsed.response).toBeUndefined();
    });

    it('returns 500 on a malformed body', async () => {
        const res = await new Promise<{ statusCode: number | undefined }>((resolve, reject) => {
            const req = http.request(
                {
                    socketPath: server.socketPath,
                    path: '/prompt',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                },
                (response) => {
                    response.resume();
                    response.on('end', () => resolve({ statusCode: response.statusCode }));
                },
            );
            req.on('error', reject);
            req.write('not-json');
            req.end();
        });
        expect(res.statusCode).toBe(500);
    });

    // Regression: initialize() used to never assign this.server, so
    // dispose() threw on this.server.close().
    it('dispose() closes cleanly', async () => {
        await expect(server.dispose()).resolves.not.toThrow();
    });

    it('dispose() is idempotent', async () => {
        await server.dispose();
        await expect(server.dispose()).resolves.not.toThrow();
    });
});
