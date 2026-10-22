import { vi } from 'vitest';
import * as vscode from 'vscode';

type ProgressTask = <R>(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<R>;

let $password: string = '';
let $warningAnswer: string | undefined = undefined;
let $infoAnswer: string | undefined = undefined;
let $config: Record<string, unknown> = {};

const DEFAULT_CONFIG: Record<string, unknown> = {
    verifyKnownHosts: 'accept',
    verifyUnknownHosts: 'accept',
};

const commands = {
    executeCommand: vi.fn(),
};

const env = {
    appRoot: '/bin/vscodium/app'
};

class SecretStorage {
    readonly values = new Map<string, string>();

    get = vi.fn(async (key: string) => this.values.get(key));
    store = vi.fn(async (key: string, value: string) => {
        this.values.set(key, value);
    });
    delete = vi.fn(async (key: string) => {
        this.values.delete(key);
    });
}

class Memento {
    readonly values = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }

    keys(): readonly string[] {
        return [...this.values.keys()];
    }

    update = vi.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
    });
}

class ExtensionContext {
    extensionPath = '/data/vscodium/extensions/open-remote-ssh';
    environmentVariableCollection = {
        persistent: false,
        replace: vi.fn(),
    };
    secrets = new SecretStorage();
    globalState = new Memento();
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
    setInfoAnswer: (answer: string | undefined) => {
        $infoAnswer = answer;
    },
    showWarningMessage: vi.fn(async (_message: string, _options?: vscode.MessageOptions, ...items: string[]) => {
        return $warningAnswer !== undefined && items.includes($warningAnswer) ? $warningAnswer : undefined;
    }),
    showInformationMessage: vi.fn(async (_message: string, ...items: string[]) => {
        return $infoAnswer !== undefined && items.includes($infoAnswer) ? $infoAnswer : undefined;
    }),
    showErrorMessage: vi.fn(async () => undefined),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    showInputBox: vi.fn(async (options?: vscode.InputBoxOptions, _token?: vscode.CancellationToken): Promise<string | undefined> => {
        if(options?.title?.startsWith('Enter password for')) {
            return $password;
        }

        return undefined;
    }),

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
        get: vi.fn((key: string, defaultValue?: unknown) => (key in $config ? $config[key] : DEFAULT_CONFIG[key] ?? defaultValue)),
        update: vi.fn(() => Promise.resolve())
    })),
    registerResourceLabelFormatter: vi.fn(),
    resetConfiguration: () => {
        $config = {};
    },
    setConfiguration: (key: string, value: unknown) => {
        $config[key] = value;
    },
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
