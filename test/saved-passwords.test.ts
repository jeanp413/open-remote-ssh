import type * as ssh2 from 'ssh2';
import type { Prompt } from 'ssh2-streams';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteSSHResolver, isPasswordPrompt } from '../src/authResolver';
import { deleteSavedPassword, forgetSavedPasswords, getPasswordSecretKey, savePassword } from '../src/ssh/savedPasswords';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';

const PASSWORD = 'correct horse';
const OLD_PASSWORD = 'battery staple';
const KEY = getPasswordSecretKey('me', 'example.com', 22);

let context: vscode.ExtensionContext;
let logger: Log;

function createAuth(port = 22) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolver = new RemoteSSHResolver(context as any, logger as any);
    const { handler, onAuthenticated } = resolver['getSSHAuthHandler']('me', 'example.com', port, [], ['publickey', 'password', 'keyboard-interactive']);

    // Calls the handler the way ssh2 does: once to start, then once per
    // failure reply, and resolves with the method it picked
    const next = (methodsLeft: string[] | null, partialSuccess = false) => new Promise<ssh2.AuthHandlerResult>(resolve => {
        void handler(methodsLeft, partialSuccess, resolve);
    });

    return { next, onAuthenticated };
}

function answerPrompts(method: ssh2.AuthHandlerResult, prompts: Prompt[]) {
    expect(method).toMatchObject({ type: 'keyboard-interactive' });
    return new Promise<string[]>(resolve => (method as ssh2.KeyboardInteractiveAuthMethod).prompt('', '', '', prompts, resolve));
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
    context = new vscode.ExtensionContext();
    logger = new Log('Remote - SSH');
    logger.capture();
    vscode.window.setPassword(PASSWORD);
    vscode.window.setInfoAnswer('Save');
});

afterEach(() => {
    // Whatever happened, no password may reach the log
    expect(logger.messages()).not.toContain(PASSWORD);
    expect(logger.messages()).not.toContain(OLD_PASSWORD);

    vscode.workspace.resetConfiguration();
    vscode.window.showInputBox.mockClear();
    vscode.window.showInformationMessage.mockClear();
});

describe('isPasswordPrompt', () => {
    it('accepts a lone hidden password prompt', () => {
        expect(isPasswordPrompt([{ prompt: 'Password: ', echo: false }])).toBe(true);
        expect(isPasswordPrompt([{ prompt: 'me@example.com\'s password: ', echo: false }])).toBe(true);
    });

    it('rejects echoed or multiple prompts', () => {
        expect(isPasswordPrompt([{ prompt: 'Password: ', echo: true }])).toBe(false);
        expect(isPasswordPrompt([{ prompt: 'Password: ', echo: false }, { prompt: 'Verification code: ', echo: false }])).toBe(false);
        expect(isPasswordPrompt([])).toBe(false);
    });

    it('rejects second factors', () => {
        for (const prompt of ['Verification code: ', 'One-time password (OATH) for `me\': ', 'Password + OTP: ', 'Password and token: ', 'Enter your password and Duo passcode: ']) {
            expect(isPasswordPrompt([{ prompt, echo: false }]), prompt).toBe(false);
        }
    });
});

describe('saved password storage', () => {
    it('keys secrets by user, host and port', () => {
        expect(getPasswordSecretKey('me', 'example.com', 2222)).toBe('openremotessh.password:me@example.com:2222');
    });

    it('records only key names, and forgets them all', async () => {
        await savePassword(context, 'a', PASSWORD);
        await savePassword(context, 'b', PASSWORD);
        await savePassword(context, 'b', OLD_PASSWORD);

        expect(context.globalState.keys().map(k => context.globalState.get(k))).toEqual([['a', 'b']]);

        await deleteSavedPassword(context, 'a');
        expect(context.secrets.values.has('a')).toBe(false);

        expect(await forgetSavedPasswords(context)).toBe(1);
        expect(context.secrets.values.size).toBe(0);
        expect(context.globalState.keys()).toEqual([]);
        expect(await forgetSavedPasswords(context)).toBe(0);
    });
});

describe('password authentication', () => {
    it('offers to save a typed password once authenticated', async () => {
        const { next, onAuthenticated } = createAuth();

        expect(await next(null)).toMatchObject({ type: 'none' });
        expect(await next(['password'])).toMatchObject({ type: 'password', password: PASSWORD });
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Save the password for me@example.com in your keychain?', 'Save', 'Not now');
    });

    it('saves nothing when declined', async () => {
        vscode.window.setInfoAnswer('Not now');
        const { next, onAuthenticated } = createAuth();

        await next(['password']);
        onAuthenticated();
        await flush();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
        expect(context.secrets.store).not.toHaveBeenCalled();
    });

    it('uses the saved password without prompting', async () => {
        context.secrets.values.set(KEY, PASSWORD);
        const { next, onAuthenticated } = createAuth();

        expect(await next(['password'])).toMatchObject({ type: 'password', password: PASSWORD });
        onAuthenticated();
        await flush();

        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('replaces a saved password the server rejects', async () => {
        context.secrets.values.set(KEY, OLD_PASSWORD);
        const { next, onAuthenticated } = createAuth();

        expect(await next(['password'])).toMatchObject({ password: OLD_PASSWORD });
        expect(await next(['password'])).toMatchObject({ password: PASSWORD });
        expect(context.secrets.delete).toHaveBeenCalledWith(KEY);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });

    it('still allows three typed tries after the saved one', async () => {
        context.secrets.values.set(KEY, OLD_PASSWORD);
        const { next } = createAuth();

        expect(await next(['password'])).toMatchObject({ password: OLD_PASSWORD });
        for (let i = 0; i < 3; i++) {
            expect(await next(['password'])).toMatchObject({ password: PASSWORD });
        }
        expect(await next(['password'])).toBe(false);
        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(3);
    });

    it('offers the password that worked, not an earlier wrong one', async () => {
        const { next, onAuthenticated } = createAuth();

        vscode.window.showInputBox.mockResolvedValueOnce(OLD_PASSWORD);
        expect(await next(['password'])).toMatchObject({ password: OLD_PASSWORD });
        expect(await next(['password'])).toMatchObject({ password: PASSWORD });
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });

    it('offers nothing when the typed password was rejected and another method got in', async () => {
        const { next, onAuthenticated } = createAuth();

        vscode.window.showInputBox.mockResolvedValueOnce(OLD_PASSWORD);
        await next(['password', 'keyboard-interactive']);
        vscode.window.showInputBox.mockResolvedValueOnce('123456');
        await answerPrompts(await next(['keyboard-interactive']), [{ prompt: 'Verification code: ', echo: false }]);
        onAuthenticated();
        await flush();

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('saves a password accepted before a second factor', async () => {
        const { next, onAuthenticated } = createAuth();

        await next(['password']);
        vscode.window.showInputBox.mockResolvedValueOnce('123456');
        // Partial success: the password was right, a second factor is required
        await answerPrompts(await next(['keyboard-interactive'], true), [{ prompt: 'Verification code: ', echo: false }]);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });

    it('keeps a saved password accepted before a second factor', async () => {
        context.secrets.values.set(KEY, PASSWORD);
        const { next } = createAuth();

        await next(['password']);
        await next(['keyboard-interactive'], true);
        // ...the second factor failed
        await next(['password', 'keyboard-interactive']);

        expect(context.secrets.delete).not.toHaveBeenCalled();
    });

    it('saves without asking when rememberPasswords is always', async () => {
        vscode.workspace.setConfiguration('rememberPasswords', 'always');
        const { next, onAuthenticated } = createAuth();

        await next(['password']);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('neither asks nor saves when rememberPasswords is never', async () => {
        vscode.workspace.setConfiguration('rememberPasswords', 'never');
        const { next, onAuthenticated } = createAuth();

        await next(['password']);
        onAuthenticated();
        await flush();

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(context.secrets.store).not.toHaveBeenCalled();
    });

    it('keeps passwords for different ports apart', async () => {
        context.secrets.values.set(KEY, OLD_PASSWORD);
        const { next } = createAuth(2222);

        expect(await next(['password'])).toMatchObject({ password: PASSWORD });
        expect(context.secrets.get).toHaveBeenCalledWith(getPasswordSecretKey('me', 'example.com', 2222));
    });

    it('prompts when the keychain cannot be read', async () => {
        context.secrets.get.mockRejectedValueOnce(new Error('no keyring'));
        const { next } = createAuth();

        expect(await next(['password'])).toMatchObject({ password: PASSWORD });
    });
});

describe('keyboard-interactive authentication', () => {
    const PASSWORD_PROMPT = [{ prompt: 'Password: ', echo: false }];
    const OTP_PROMPT = [{ prompt: 'Verification code: ', echo: false }];

    it('answers a lone password prompt with the saved password', async () => {
        context.secrets.values.set(KEY, PASSWORD);
        const { next } = createAuth();

        expect(await answerPrompts(await next(['keyboard-interactive']), PASSWORD_PROMPT)).toEqual([PASSWORD]);
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });

    it('offers to save a password typed at a password prompt', async () => {
        const { next, onAuthenticated } = createAuth();

        vscode.window.showInputBox.mockResolvedValueOnce(PASSWORD);
        await answerPrompts(await next(['keyboard-interactive']), PASSWORD_PROMPT);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });

    it('saves only the password when a code is asked in the same attempt', async () => {
        const { next, onAuthenticated } = createAuth();

        const method = await next(['keyboard-interactive']);
        vscode.window.showInputBox.mockResolvedValueOnce(PASSWORD);
        await answerPrompts(method, PASSWORD_PROMPT);
        vscode.window.showInputBox.mockResolvedValueOnce('123456');
        await answerPrompts(method, OTP_PROMPT);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });

    it('never answers or saves a one-time code', async () => {
        context.secrets.values.set(KEY, PASSWORD);
        const { next, onAuthenticated } = createAuth();

        vscode.window.showInputBox.mockResolvedValueOnce('123456');
        expect(await answerPrompts(await next(['keyboard-interactive']), OTP_PROMPT)).toEqual(['123456']);
        onAuthenticated();
        await flush();

        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(context.secrets.store).not.toHaveBeenCalled();
    });

    it('replaces a saved password the server rejects', async () => {
        context.secrets.values.set(KEY, OLD_PASSWORD);
        const { next, onAuthenticated } = createAuth();

        expect(await answerPrompts(await next(['keyboard-interactive']), PASSWORD_PROMPT)).toEqual([OLD_PASSWORD]);
        vscode.window.showInputBox.mockResolvedValueOnce(PASSWORD);
        expect(await answerPrompts(await next(['keyboard-interactive']), PASSWORD_PROMPT)).toEqual([PASSWORD]);
        expect(context.secrets.delete).toHaveBeenCalledWith(KEY);
        onAuthenticated();

        await vi.waitFor(() => expect(context.secrets.values.get(KEY)).toBe(PASSWORD));
    });
});
