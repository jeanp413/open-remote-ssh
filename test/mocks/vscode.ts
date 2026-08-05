import { vi } from 'vitest';
import * as vscode from 'vscode';

type ProgressTask = <R>(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<R>;

let $password: string = '';
let $warningAnswer: string | undefined = undefined;
let $config: Record<string, unknown> = {};

const commands = {
    executeCommand: vi.fn(),
};

const env = {
    appRoot: '/bin/vscodium/app'
};

class ExtensionContext {
    extensionPath = '/data/vscodium/extensions/open-remote-ssh';
    environmentVariableCollection = {
        persistent: false,
        replace: vi.fn(),
    };
}

enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15
}

class RemoteAuthorityResolverContext {
    resolveAttempt = 0;
}

class RemoteAuthorityResolverError extends Error {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    static NotAvailable(message?: string, _handled?: boolean): RemoteAuthorityResolverError {
        return new RemoteAuthorityResolverError(message ?? 'NotAvailable');
    }

    static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError {
        return new RemoteAuthorityResolverError(message ?? 'TemporarilyNotAvailable');
    }

    constructor(message?: string) {
        super(message);
    }
}

class ResolvedAuthority {
    constructor(readonly host: string, readonly port: number, readonly connectionToken?: string) {
    }
}

const version = '1.126.04524';

const window = {
    createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn()
    })),
    setPassword: (password: string) => {
        $password = password;
    },
    setWarningAnswer: (answer: string | undefined) => {
        $warningAnswer = answer;
    },
    showWarningMessage: async (_message: string, _options?: vscode.MessageOptions, ...items: string[]) => {
        return $warningAnswer !== undefined && items.includes($warningAnswer) ? $warningAnswer : undefined;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInputBox: async (options?: vscode.InputBoxOptions, _token?: vscode.CancellationToken) => {
        if(options?.title?.startsWith('Enter password for')) {
            return $password;
        }

        return undefined;
    },

    withProgress: (_options: vscode.ProgressOptions, task: ProgressTask) => {
        const mockProgressReporter = {
            report: vi.fn(),
            then: vi.fn(),
        };

        return task(mockProgressReporter, {} as unknown) as Promise<unknown>;
    },
};

const workspace = {
    getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, defaultValue?: unknown) => (key in $config ? $config[key] : defaultValue)),
        update: vi.fn(() => Promise.resolve())
    })),
    registerResourceLabelFormatter: vi.fn(),
    setConfig: (key: string, value: unknown) => {
        $config[key] = value;
    },
    resetConfig: () => {
        $config = {};
    }
};

export {
    commands,
    env,
    ExtensionContext,
    ProgressLocation,
    RemoteAuthorityResolverContext,
    RemoteAuthorityResolverError,
    ResolvedAuthority,
    window,
    version,
    workspace,
};
