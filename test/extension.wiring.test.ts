import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideDefaultProfile, decideTmuxWiring, defaultProfileSettingKey, deriveTmuxSessionContext, idempotentResolveHandler, lazyExec, onceOnly, readTmuxSettings, reconcileDefaultTerminalProfile, TMUX_PROFILE_TITLE } from '../src/extension';
import type { RemoteSSHResolver } from '../src/authResolver';
import type Log from '../src/common/logger';
import { ConfigurationTarget, configOverrides, inspectOverrides, TerminalProfile, updateCalls } from './mocks/vscode';
import { FallbackTerminalProvider } from '../src/tmux/fallbackTerminalProvider';

/** A no-op Log — the default-profile reconcile only calls `trace` on the (untaken) error path. */
const noopLog = { trace: (): void => { /* no-op */ } } as unknown as Log;

/** The fully-qualified setting id the terminal layer writes its Workspace-scope default to. */
const DEFAULT_PROFILE_ID = 'terminal.integrated.defaultProfile.linux';

// extension.ts is activation wiring only; these tests pin the two behaviours the
// reconnect-safety fix (headline #3, "post-reconnect terminals fail") introduces:
//
//   * lazyExec — the provider/reaper `exec` resolves the resolver's *current*
//     SSHConnection at call time, so a reconnect's fresh connection is used and a
//     new terminal no longer targets the dead pre-reconnect channel.
//   * idempotentResolveHandler — resolve-success fires on every (re)connect; the
//     tmux layer must be wired exactly once and only *refreshed* thereafter (never
//     re-registering the terminal profile provider, which throws "already
//     registered" and would orphan the surviving provider).
//
// The heavier activate()-level wiring tests (settings, default-profile scope,
// session-context host parse) land with those tasks + the expanded vscode mock.

/** A fake SSHConnection exposing just the `exec` this layer uses; `tag` lets a test
 * tell which connection actually answered. */
function fakeConnection(tag: string) {
    return { exec: vi.fn(async () => ({ stdout: tag, stderr: '' })) };
}

/** A resolver stub whose live connection a test can swap between exec calls (models
 * a reconnect handing the resolver a fresh `SSHConnection`). */
function fakeResolver(connection: unknown) {
    let current = connection;
    const resolver = { getSSHConnection: () => current } as unknown as RemoteSSHResolver;
    return { resolver, swap: (next: unknown): void => { current = next; } };
}

describe('lazyExec: post-reconnect exec targets the live connection', () => {
    it('resolves the resolver\'s current connection at call time, not at wire time', async () => {
        const first = fakeConnection('first');
        const second = fakeConnection('second');
        const { resolver, swap } = fakeResolver(first);
        const exec = lazyExec(resolver);

        expect((await exec('tmux ls')).stdout).toBe('first');
        swap(second); // a reconnect swaps in a fresh SSHConnection
        expect((await exec('tmux ls')).stdout).toBe('second');

        expect(first.exec).toHaveBeenCalledTimes(1);
        expect(second.exec).toHaveBeenCalledTimes(1);
    });

    it('rejects when no connection is live (provider/reaper degrade via never-throw paths)', async () => {
        const { resolver } = fakeResolver(undefined);
        await expect(lazyExec(resolver)('tmux ls')).rejects.toThrow();
    });
});

describe('idempotentResolveHandler: wire once, refresh on reconnect', () => {
    it('wires on the first resolve, then only refreshes on every later resolve', () => {
        const refresh = vi.fn();
        const wire = vi.fn(() => ({ refresh }));
        const handler = idempotentResolveHandler(wire);

        handler(); // first connect → wire
        handler(); // reconnect → refresh only
        handler(); // reconnect → refresh only

        expect(wire).toHaveBeenCalledTimes(1);   // never re-registers
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('retries wiring on a later resolve when the gates were not yet satisfied', () => {
        const refresh = vi.fn();
        let call = 0;
        // First resolve: gates fail (e.g. tmux capability not ready) → undefined, no
        // layer retained. A later resolve wires for real; then reconnects refresh it.
        const wire = vi.fn(() => (call++ === 0 ? undefined : { refresh }));
        const handler = idempotentResolveHandler(wire);

        handler(); // gate failed → no layer retained
        handler(); // now wired
        handler(); // reconnect → refresh

        expect(wire).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});

// The connect-time image sweep used to live inside `wireTmuxTerminalLayer`, which tied
// housekeeping for pasted screenshots to a gate that has nothing to do with it: pasting
// needs only a remote authority, but the sweep ran only when the tmux layer wired. With
// `remote.SSH.tmux.enabled: "off"`, a remote without tmux, or an empty remote window,
// images uploaded fine and nothing ever deleted them. It is now composed into the
// resolve-success callback alongside the wiring, and must run exactly once per window.
describe('onceOnly: connect-time housekeeping that must not repeat on reconnect', () => {
    it('runs on the first call and never again', () => {
        const action = vi.fn();
        const once = onceOnly(action);

        once();
        once();
        once();

        expect(action).toHaveBeenCalledTimes(1);
    });

    it('does not run until it is called', () => {
        const action = vi.fn();
        onceOnly(action);
        expect(action).not.toHaveBeenCalled();
    });

    it('stays spent even when the action throws', () => {
        const action = vi.fn(() => { throw new Error('sweep exploded'); });
        const once = onceOnly(action);

        // A throwing sweep must not arm itself to be retried on every later reconnect.
        expect(() => once()).toThrow('sweep exploded');
        expect(() => once()).not.toThrow();
        expect(action).toHaveBeenCalledTimes(1);
    });
});

// The four settings (`historyLimit`, `reapOnConnect`, `enabled`, `setDefaultProfile`)
// are read together so configuration controls wiring, cleanup, and default-profile writes.
// `readTmuxSettings` is the single read seam (pins section, key names, and the
// package.json defaults) and `decideTmuxWiring` is the pure enablement rule that
// makes `enabled:'on'` ("require tmux") observably different from `'auto'`.
describe('readTmuxSettings: the four remote.SSH.tmux.* settings are read', () => {
    beforeEach(() => configOverrides.clear());

    it('falls back to the package.json defaults when nothing is configured', () => {
        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('auto');
        expect(settings.historyLimit).toBe(50000);
        expect(settings.reapOnConnect).toBe(true);
        expect(settings.setDefaultProfile).toBe(true);
    });

    it.each([false, true])('reads seeded values with setDefaultProfile=%s from the remote.SSH configuration section', (setDefaultProfile) => {
        configOverrides.set('remote.SSH.tmux.enabled', 'on');
        configOverrides.set('remote.SSH.tmux.historyLimit', 1000);
        configOverrides.set('remote.SSH.tmux.reapOnConnect', false);
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', setDefaultProfile);

        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('on');
        expect(settings.historyLimit).toBe(1000);
        expect(settings.reapOnConnect).toBe(false);
        expect(settings.setDefaultProfile).toBe(setDefaultProfile);
    });
});

describe('decideTmuxWiring: enabled setting × tmux availability', () => {
    it('off → skip, whether or not tmux is available', () => {
        expect(decideTmuxWiring('off', true)).toBe('skip');
        expect(decideTmuxWiring('off', false)).toBe('skip');
    });

    it('auto → wire when available, skip silently when not', () => {
        expect(decideTmuxWiring('auto', true)).toBe('wire');
        expect(decideTmuxWiring('auto', false)).toBe('skip');
    });

    it('on → wire when available, require-error when not (the "fail if unavailable" contract)', () => {
        expect(decideTmuxWiring('on', true)).toBe('wire');
        expect(decideTmuxWiring('on', false)).toBe('require-error');
    });

    it('an unknown value degrades to auto behaviour', () => {
        expect(decideTmuxWiring('weird', true)).toBe('wire');
        expect(decideTmuxWiring('weird', false)).toBe('skip');
    });
});

// `terminal.integrated.defaultProfile.linux` is the one settings write the terminal layer
// makes — Workspace scope only. The old check inspected `workspaceValue` alone, so a
// User/Global (or remote-user) default was silently clobbered by the Workspace write, and a
// stale write was never removed when tmux went off/unavailable (leaving the default pointing
// at an unregistered profile). `decideDefaultProfile` is the pure rule; `reconcile…` applies it.
describe('decideDefaultProfile: workspace default-profile write vs. user scopes', () => {
    it('wiring + nothing set at any scope → set', () => {
        expect(decideDefaultProfile(undefined, true)).toBe('set');
        expect(decideDefaultProfile({}, true)).toBe('set');
    });

    it('wiring + a user default at any scope → none (never override)', () => {
        expect(decideDefaultProfile({ workspaceValue: 'zsh' }, true)).toBe('none');
        expect(decideDefaultProfile({ globalValue: 'zsh' }, true)).toBe('none');
        expect(decideDefaultProfile({ workspaceFolderValue: 'zsh' }, true)).toBe('none');
    });

    it('wiring + only our own prior workspace write present → none (idempotent, no re-write)', () => {
        expect(decideDefaultProfile({ workspaceValue: TMUX_PROFILE_TITLE }, true)).toBe('none');
    });

    it('not wiring + our own stale workspace write → clear', () => {
        expect(decideDefaultProfile({ workspaceValue: TMUX_PROFILE_TITLE }, false)).toBe('clear');
    });

    it('not wiring + a user workspace choice → none (never remove the user\'s value)', () => {
        expect(decideDefaultProfile({ workspaceValue: 'zsh' }, false)).toBe('none');
    });

    it('not wiring + nothing set → none', () => {
        expect(decideDefaultProfile(undefined, false)).toBe('none');
        expect(decideDefaultProfile({}, false)).toBe('none');
    });

    it('not wiring + a global value (not ours to clean) → none', () => {
        expect(decideDefaultProfile({ globalValue: TMUX_PROFILE_TITLE }, false)).toBe('none');
    });
});

// `currentTmuxSessionContext` keyed the session hash off `vscode.env.remoteName`, which is
// the remote *type* ('ssh-remote') and identical for every SSH host — so tmuxSession.ts's
// host+workspace identity collapsed to workspace-only, and the cwd fell back to a fabricated
// literal `/home/user`. `deriveTmuxSessionContext` is the pure seam: it decodes the real host
// from the `ssh-remote+<encoded-dest>` authority the resolver put on the workspace-folder URI
// (SSHDestination.parseEncoded, exactly as getRemoteWorkspaceLocationData does), and keys the
// cwd to the real folder path — no fabrication.
describe('deriveTmuxSessionContext: (host, workspace) parsed from the resolved authority', () => {
    /** Build the `ssh-remote+<hex-json>` authority VS Code carries for a resolved host. */
    function remoteFolder(hostName: string, path: string, user = 'me', port = 22) {
        const encoded = Buffer.from(JSON.stringify({ hostName, user, port })).toString('hex');
        return { scheme: 'vscode-remote', authority: `ssh-remote+${encoded}`, path };
    }

    it('parses the real hostname from the authority, never the literal "ssh-remote" type', () => {
        const ctx = deriveTmuxSessionContext(remoteFolder('prod.example.com', '/home/deploy/app'));
        expect(ctx).toEqual({ hostKey: 'prod.example.com', workspaceKey: '/home/deploy/app' });
        expect(ctx?.hostKey).not.toBe('ssh-remote'); // the bug this fixes
    });

    it('decodes an \\x-escaped (uppercase-preserving) authority form too', () => {
        // SSHDestination.toEncodedString() escapes uppercase as \xHH (M=0x4d, H=0x48);
        // parseEncoded reverses it, so we must not naively read the authority verbatim.
        const ctx = deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'ssh-remote+\\x4dy\\x48ost', path: '/w' });
        expect(ctx?.hostKey).toBe('MyHost');
    });

    it('keys workspaceKey to the folder path (the tmux -c cwd), never a fabricated /home/user', () => {
        const ctx = deriveTmuxSessionContext(remoteFolder('h', '/srv/project'));
        expect(ctx?.workspaceKey).toBe('/srv/project');
    });

    it('gives two hosts sharing a workspace path distinct identities (host is part of the key)', () => {
        const a = deriveTmuxSessionContext(remoteFolder('host-a', '/home/me/app'));
        const b = deriveTmuxSessionContext(remoteFolder('host-b', '/home/me/app'));
        expect(a?.hostKey).toBe('host-a');
        expect(b?.hostKey).toBe('host-b');
        expect(a?.hostKey).not.toBe(b?.hostKey);
    });

    it('returns undefined with no workspace folder (empty window — nothing to key, nothing fabricated)', () => {
        expect(deriveTmuxSessionContext(undefined)).toBeUndefined();
    });

    it('returns undefined for a non-remote (local) folder', () => {
        expect(deriveTmuxSessionContext({ scheme: 'file', authority: '', path: '/local' })).toBeUndefined();
    });

    it('returns undefined for a different remote type (not ssh-remote, e.g. WSL)', () => {
        expect(deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: '/w' })).toBeUndefined();
    });

    it('returns undefined for an empty/undecodable host (ssh-remote+ with nothing after)', () => {
        expect(deriveTmuxSessionContext({ scheme: 'vscode-remote', authority: 'ssh-remote+', path: '/w' })).toBeUndefined();
    });
});

describe('reconcileDefaultTerminalProfile: applies the decision to Workspace scope only', () => {
    beforeEach(() => {
        configOverrides.clear();
        inspectOverrides.clear();
        updateCalls.length = 0;
    });

    it('wiring + nothing set → one Workspace-scope write of the tmux profile', () => {
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: TMUX_PROFILE_TITLE, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('wiring + explicit setDefaultProfile=true + nothing set → one Workspace-scope write', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', true);
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: TMUX_PROFILE_TITLE, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('wiring + setDefaultProfile=false + nothing set → no write', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('wiring + a Workspace default already set → no write', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('wiring + a User/Global default set → no write (a Workspace write would clobber it)', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { globalValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, true);
        expect(updateCalls).toHaveLength(0);
    });

    it('not wiring + a stale write of ours → one Workspace-scope removal (undefined)', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: TMUX_PROFILE_TITLE });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: undefined, target: ConfigurationTarget.Workspace },
        ]);
    });

    it('not wiring + setDefaultProfile=false + our stale Workspace default → still clear', () => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: TMUX_PROFILE_TITLE });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toEqual([
            { id: DEFAULT_PROFILE_ID, value: undefined, target: ConfigurationTarget.Workspace },
        ]);
    });

    it.each([
        { workspaceValue: 'zsh' },
        { globalValue: 'zsh' },
        { workspaceFolderValue: 'zsh' },
        { globalValue: TMUX_PROFILE_TITLE },
    ])('not wiring + setDefaultProfile=false preserves user scopes %j', (scopes) => {
        configOverrides.set('remote.SSH.tmux.setDefaultProfile', false);
        inspectOverrides.set(DEFAULT_PROFILE_ID, scopes);
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toHaveLength(0);
    });

    it('not wiring + nothing of ours to clean → no write', () => {
        inspectOverrides.set(DEFAULT_PROFILE_ID, { workspaceValue: 'zsh' });
        reconcileDefaultTerminalProfile(noopLog, false);
        expect(updateCalls).toHaveLength(0);
    });
});

// When tmux is unavailable or disabled, the "Persistent Shell" profile should still be
// available (via a fallback plain-shell provider) so the user sees the profile in the
// terminal picker even if tmux is not working. This prevents "Profile not found" errors
// and provides graceful degradation when the setting is 'off' or the remote lacks tmux.
// activate() seeds the shared TerminalProfileRegistration with this provider (before the
// tmux-gated wiring), and wireTmuxTerminalLayer *swaps* the real TmuxTerminalProvider in
// once wired. It is a swap, not a second registration: VS Code allows one provider per
// profile id and throws "already registered" otherwise — the v1.0.0 bug this fallback was
// silently masking. See test/tmux/profileRegistration.test.ts.
// VS Code picks the `terminal.integrated.defaultProfile.<suffix>` suffix from the REMOTE
// operating system, not from "is this a Unix host" — its terminal profile service resolves
// the suffix via the remote agent environment (`windows` / `osx` / `linux`). The layer
// hardcoded `.linux`, so on a macOS remote — which IS wired, since the tmux probe only gates
// off an explicit `windows` platform — the write went to a key VS Code never reads. The
// profile registered fine but "New Terminal" opened a plain non-persistent shell, and the
// user had to pick "Persistent Shell" from the dropdown every single time. The mirror
// cleanup path and the "did the user already set a default?" inspection were equally inert.
describe('defaultProfileSettingKey: the suffix follows the REMOTE platform', () => {
    it('maps macOS remotes to the osx suffix, not linux', () => {
        expect(defaultProfileSettingKey('macos')).toBe('defaultProfile.osx');
        expect(defaultProfileSettingKey('darwin')).toBe('defaultProfile.osx');
    });

    it('maps Windows remotes to the windows suffix', () => {
        expect(defaultProfileSettingKey('windows')).toBe('defaultProfile.windows');
    });

    it('maps Linux and other Unix remotes to the linux suffix', () => {
        expect(defaultProfileSettingKey('linux')).toBe('defaultProfile.linux');
        expect(defaultProfileSettingKey('freebsd')).toBe('defaultProfile.linux');
    });

    // An unlabelled platform is treated as a Unix remote everywhere else in this codebase
    // (see tmuxBootstrap's gate, which only short-circuits on the literal 'windows'), so the
    // default here must agree rather than invent a third behaviour.
    it('defaults to linux when the remote platform is unknown', () => {
        expect(defaultProfileSettingKey(undefined)).toBe('defaultProfile.linux');
    });
});

describe('FallbackTerminalProvider: graceful degradation when tmux is not wired', () => {
    it('provides a plain vscode.TerminalProfile (no tmux shell/args) synchronously', () => {
        const provider = new FallbackTerminalProvider();
        const profile = provider.provideTerminalProfile();

        expect(profile).toBeInstanceOf(TerminalProfile);
        // No special shellPath/shellArgs/cwd — VS Code falls back to its own default shell.
        expect((profile as InstanceType<typeof TerminalProfile>).options).toEqual({});
    });

    it('returns a fresh profile instance on every call (no shared/stale state)', () => {
        const provider = new FallbackTerminalProvider();
        expect(provider.provideTerminalProfile()).not.toBe(provider.provideTerminalProfile());
    });
});
