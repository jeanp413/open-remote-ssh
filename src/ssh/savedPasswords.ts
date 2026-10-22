import * as vscode from 'vscode';

export type RememberPasswordsPolicy = 'ask' | 'always' | 'never';

// SecretStorage can't list its keys on every editor version this extension
// supports, so the names of the saved secrets — never their values — are kept
// here for "Forget Saved Passwords".
const SAVED_KEYS_STATE = 'openremotessh.savedPasswordKeys';

export function getPasswordSecretKey(user: string, host: string, port: number): string {
    return `openremotessh.password:${user}@${host}:${port}`;
}

export function getSavedPassword(context: vscode.ExtensionContext, key: string): Thenable<string | undefined> {
    return context.secrets.get(key);
}

export async function savePassword(context: vscode.ExtensionContext, key: string, password: string): Promise<void> {
    // Record the name first: a name without a secret is harmless, a secret
    // without a name would survive "Forget Saved Passwords"
    const keys = context.globalState.get<string[]>(SAVED_KEYS_STATE, []);
    if (!keys.includes(key)) {
        await context.globalState.update(SAVED_KEYS_STATE, [...keys, key]);
    }
    await context.secrets.store(key, password);
}

export async function deleteSavedPassword(context: vscode.ExtensionContext, key: string): Promise<void> {
    await context.secrets.delete(key);
    const keys = context.globalState.get<string[]>(SAVED_KEYS_STATE, []);
    if (keys.includes(key)) {
        await context.globalState.update(SAVED_KEYS_STATE, keys.filter(k => k !== key));
    }
}

/**
 * Deletes every saved password and returns how many there were.
 */
export async function forgetSavedPasswords(context: vscode.ExtensionContext): Promise<number> {
    const keys = context.globalState.get<string[]>(SAVED_KEYS_STATE, []);
    for (const key of keys) {
        await context.secrets.delete(key);
    }
    // Only drop the names deleted above, in case a password was saved meanwhile
    const remaining = context.globalState.get<string[]>(SAVED_KEYS_STATE, []).filter(k => !keys.includes(k));
    await context.globalState.update(SAVED_KEYS_STATE, remaining.length ? remaining : undefined);
    return keys.length;
}
