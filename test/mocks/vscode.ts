import { vi } from 'vitest';
import * as vscode from 'vscode';

type ProgressTask = <R>(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<R>;

let $password: string = '';

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

// In-memory overrides for `workspace.getConfiguration().get` lookups; tests
// use `setConfiguration` to control settings like `remote.SSH.configFile`.
// The map lives on globalThis because `vi.resetModules()` (used by the
// resolver rewire) re-instantiates this module, which would otherwise cut
// tests off from the instance the resolver ends up using.
const globalSettings = globalThis as { __openRemoteSshTestConfiguration?: Map<string, unknown> };
const configuration: Map<string, unknown> = globalSettings.__openRemoteSshTestConfiguration ??= new Map();

const workspace = {
    getConfiguration: vi.fn((section?: string) => ({
        // Accepts both the scoped key written by `setConfiguration`
        // (`remote.SSH.configFile`) and the section-relative one (`configFile`).
        get: vi.fn((key: string, defaultValue?: unknown) => {
            const scoped = section ? `${section}.${key}` : key;
            if (configuration.has(scoped)) {
                return configuration.get(scoped);
            }
            if (configuration.has(key)) {
                return configuration.get(key);
            }
            return defaultValue;
        }),
        update: vi.fn(() => Promise.resolve())
    })),
    registerResourceLabelFormatter: vi.fn()
};

/** Overrides a configuration value for the current test file. */
function setConfiguration(key: string, value: unknown): void {
    configuration.set(key, value);
}

function clearConfiguration(): void {
    configuration.clear();
}

export {
    clearConfiguration,
    commands,
    env,
    ExtensionContext,
    ProgressLocation,
    RemoteAuthorityResolverContext,
    RemoteAuthorityResolverError,
    ResolvedAuthority,
    setConfiguration,
    window,
    version,
    workspace,
};
