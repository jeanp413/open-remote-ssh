import { describe, expect, it, vi } from 'vitest';
import { SLOT_MAPPING_STATE_KEY, TmuxTerminalProvider } from '../../src/tmux/terminalProvider';
import { buildAttachOrCreateArgv, buildKillSession, escapeShellArg, sessionName } from '../../src/tmux/tmuxSession';

// The terminal provider is the user-facing heart of the fork: it decides which
// tmux session (slot) each VS Code terminal maps to. Both hard invariants live
// here — *invisible* (plain terminal options, no tmux branding) and *no zombies /
// no stealing* (a second client never -A-attaches into another client's live
// session; hand-off adopts detached orphans; the same client re-attaches its own).
// Every decision is pure over an injected `exec` + `workspaceState`, so the whole
// contract is unit-testable with no real ssh2 / VS Code.

const HOST = 'example.com';
const WS = '/home/user/proj';
const CWD = '/home/user/proj';

/** Deterministic session name for a slot in the test workspace. */
const name = (slot: number): string => sessionName(HOST, WS, slot);

/** The subset of `vscode.TerminalOptions` this provider produces. */
interface LaunchOptions {
    readonly name?: string;
    readonly shellPath?: string;
    readonly shellArgs?: string[];
    readonly cwd?: string;
    readonly isTransient?: boolean;
}

/** The `-s <name>` target a launched/returned option-set attaches to. */
const targetSession = (options: LaunchOptions): string => {
    const args = options.shellArgs ?? [];
    return args[args.indexOf('-s') + 1] ?? '';
};

/** A fake `vscode.Memento` backed by a Map — models client-local workspaceState. */
function fakeState(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        keys: (): string[] => [...store.keys()],
        get: (key: string, def?: unknown): unknown => (store.has(key) ? store.get(key) : def),
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
    };
}

/** A `list-sessions` stdout line: `<name> <attached> <windows> <created> <paneDead>`. */
const row = (sessionId: string, attached: boolean, windows = 1, created = 1700000000, paneDead = false): string =>
    `${sessionId} ${attached ? 1 : 0} ${windows} ${created} ${paneDead ? 1 : 0}`;

/**
 * An exec that answers `list-sessions` with the given rows and `has-session`
 * against a set of existing names (empty stderr = present; not-found stderr =
 * absent), mirroring how the real tmux CLI reports over `SSHConnection#exec`
 * (no exit code surfaced — status is read from stdout/stderr).
 *
 * `has-session` is matched on the EXACT `-t =<name>` target the real tmux uses,
 * not a loose substring of the whole command: a bare `includes(name)` mimicked the
 * very prefix-match bug the `=` fix removes (it would report `code-<h>-01` present
 * when only `code-<h>-0` exists). The `=` + trailing quote bound the token.
 */
function fakeExec(opts: { list?: string[]; existing?: string[] } = {}) {
    const listOut = (opts.list ?? []).join('\n');
    const existing = new Set(opts.existing ?? []);
    return vi.fn(async (command: string) => {
        if (command.includes('list-sessions')) {
            return { stdout: listOut, stderr: '' };
        }
        if (command.includes('has-session')) {
            const present = [...existing].some(n => command.includes(`=${escapeShellArg(n)}`));
            return present ? { stdout: '', stderr: '' } : { stdout: '', stderr: `can't find session` };
        }
        return { stdout: '', stderr: '' };
    });
}

function makeProvider(over: {
    exec?: ReturnType<typeof fakeExec>;
    state?: ReturnType<typeof fakeState>;
    opened?: LaunchOptions[];
    historyLimit?: number;
    tmuxPath?: string;
    listTerminals?: () => readonly import('vscode').Terminal[];
    reviveGraceMs?: number;
    reviveDeadlineMs?: number;
    reviveQuietMs?: number;
} = {}) {
    const opened = over.opened ?? [];
    const exec = over.exec ?? fakeExec();
    const state = over.state ?? fakeState();
    const provider = new TmuxTerminalProvider({
        ctx: { hostKey: HOST, workspaceKey: WS, cwd: CWD },
        exec,
        state,
        openTerminal: (options: LaunchOptions): number => opened.push(options),
        listTerminals: over.listTerminals,
        reviveGraceMs: over.reviveGraceMs ?? 0,
        // Defaults to the grace so the existing waiting tests stay as quick as they were;
        // the claim-driven tests below set it explicitly.
        reviveDeadlineMs: over.reviveDeadlineMs ?? over.reviveGraceMs ?? 0,
        reviveQuietMs: over.reviveQuietMs ?? 0,
        log: { info: vi.fn(), trace: vi.fn() },
        historyLimit: over.historyLimit,
        tmuxPath: over.tmuxPath,
    });
    return { provider, opened, exec, state };
}

/** The options carried by a returned `TerminalProfile` (mock stores them as-is). */
const optionsOf = (profile: { options: unknown }): LaunchOptions => profile.options as LaunchOptions;

describe('slot allocation', () => {
    it('gives a fresh window slot 0', async () => {
        const { provider } = makeProvider();
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('hands out 0, 1, 2 for three terminals opened in a row', async () => {
        const { provider } = makeProvider();
        const slots = [
            targetSession(optionsOf(await provider.provideTerminalProfile())),
            targetSession(optionsOf(await provider.provideTerminalProfile())),
            targetSession(optionsOf(await provider.provideTerminalProfile())),
        ];
        expect(slots).toEqual([name(0), name(1), name(2)]);
    });

    it('reuses the lowest freed slot after a terminal closes (close 1, open → 1)', async () => {
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // 0
        await provider.provideTerminalProfile(); // 1
        await provider.provideTerminalProfile(); // 2
        provider.releaseSlot(1);                 // close-detach slot 1
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    it('never steals a slot another client is attached to (second client → slot 2)', async () => {
        // PC is attached to slots 0 and 1; the laptop has an empty local mapping.
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), true)] });
        const { provider } = makeProvider({ exec });
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(2));
    });
});

describe('no-steal TOCTOU (re-probe immediately before returning)', () => {
    // The no-steal guard reads a `list-sessions` snapshot, but VS Code spawns the
    // tmux process only *after* provideTerminalProfile returns — a window this code
    // cannot observe. A single snapshot is therefore TOCTOU: another client can
    // attach the chosen slot in between. The provider re-probes as the last remote
    // read before committing to *shrink* (never close) that window, re-picking a
    // slot taken since the first snapshot instead of stealing it.

    it('skips a slot taken (attached elsewhere) between the first snapshot and returning', async () => {
        // First `list-sessions`: empty → slot 0 looks free. Every later one: slot 0
        // is now attached by another client. Without the re-probe the provider hands
        // out slot 0 (a steal); with it, the fresher snapshot pushes it to slot 1.
        let listCalls = 0;
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                listCalls++;
                return { stdout: listCalls === 1 ? '' : row(name(0), true), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const { provider } = makeProvider({ exec });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
        expect(listCalls).toBeGreaterThanOrEqual(2); // re-probed before returning
    });

    it('keeps its chosen slot when the re-probe shows only an unrelated slot taken', async () => {
        // A re-probe revealing another client on some *other* slot must not bump a
        // new terminal off a slot that is still free.
        let listCalls = 0;
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                listCalls++;
                return { stdout: listCalls === 1 ? '' : row(name(5), true), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const { provider } = makeProvider({ exec });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });
});

describe('no-steal guard survives a transient probe failure (snapshot retention)', () => {
    // `attachedRemoteSlots` IS the no-steal guard. A *transient* `list-sessions`
    // failure (network blip mid-session) must not silently disarm it: the last known
    // snapshot is retained, so a new terminal still skips the slot another client
    // holds instead of stealing it. Clearing the set on every failed probe would open
    // exactly the steal the guard exists to prevent. Retention errs safe — a slot the
    // other client has since detached stays guarded only until the next *successful*
    // probe re-syncs it (self-healing, worst case a higher slot number, never a steal).

    it('retains the last attached-elsewhere snapshot when a later probe fails', async () => {
        // First probe: slot 0 is attached by another client → seeds the guard. Every
        // later probe throws. With the bug (clear-on-failure) the guard empties and the
        // new terminal steals slot 0; with retention it still skips it → slot 1.
        let listCalls = 0;
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                listCalls++;
                if (listCalls === 1) {
                    return { stdout: row(name(0), true), stderr: '' };
                }
                throw new Error('connection reset'); // transient blip on every later probe
            }
            return { stdout: '', stderr: '' };
        });
        const { provider } = makeProvider({ exec });

        await provider.initialize(); // seeds attachedRemoteSlots = {0} from the good snapshot
        // The failing probes inside provideTerminalProfile must keep slot 0 guarded.
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('init race (no duplicate/mirrored tab on a slot being restored or adopted)', () => {
    // extension.ts kicks off initialize() fire-and-forget, then registers the
    // profile provider. A "New Terminal" (or the auto-terminal VS Code opens on
    // connect) could call provideTerminalProfile() *before* initialize() finished
    // restoring/adopting — and allocateSlot, ignoring the persisted mapping and the
    // pending restore, handed out slot 0 too. Two terminals on one tmux session →
    // shared view, mirrored keystrokes. Two complementary guards close it: mapped
    // slots are reserved synchronously (before initialize()'s first await), and
    // provideTerminalProfile awaits `initialized` so adoption (remote-discovered,
    // not yet in the mapping) also completes first.

    it('reserves a mapped survivor slot so a new terminal never collides with it', async () => {
        // A survivor mapping from a previous window: slot 0 is spoken for. Even
        // before initialize() runs, a brand-new terminal must skip it → slot 1.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const { provider } = makeProvider({ state });
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    it('awaits initialize() so a terminal created mid-restore does not collide with an adopted orphan', async () => {
        // Force the race a near-synchronous fake exec would hide: hold initialize()'s
        // list-sessions probe open. There is a detached orphan on slot 0 that no client
        // holds and this client has not mapped (hand-off) — initialize() will adopt it.
        // Without the gate, provideTerminalProfile races ahead and allocates the very
        // slot 0 that adoption is about to claim (mirrored tab). The gate must keep it
        // pending until initialize() settles, then hand out slot 1.
        let releaseList!: () => void;
        const listGate = new Promise<void>(res => { releaseList = res; });
        let firstList = true;
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                if (firstList) {
                    firstList = false;
                    await listGate; // only initialize()'s probe blocks
                }
                return { stdout: row(name(0), false), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        const initP = provider.initialize(); // fire-and-forget, exactly like extension.ts
        let profile: { options: unknown } | undefined;
        const profileP = provider.provideTerminalProfile().then(p => { profile = p; });

        // Drain every pending microtask; without the gate, allocation would have run.
        await new Promise<void>(res => setTimeout(res, 0));
        expect(profile).toBeUndefined(); // still gated on initialize()

        releaseList();
        await initP;
        await profileP;

        // The gate held, so nothing was allocated behind adoption's back. What the caller
        // then receives is the adopted session itself, not a second one beside it: with the
        // restore queue, a profile request during connect is answered from the queue. That
        // is the only correct answer when the caller is VS Code reviving a persisted
        // terminal — indistinguishable from a user's "New Terminal", since the API passes no
        // context — and it is a reasonable one either way, because the alternative is
        // handing someone a fresh empty session while their own sits unclaimed.
        expect(targetSession(optionsOf(profile!))).toBe(name(0)); // the adopted orphan
        expect(opened).toEqual([]);                               // nothing opened behind it
    });

    it('drains reservations after initialize so a closed-then-reopened slot is reusable', async () => {
        // Reservation must be a connect-time guard, not permanent: once initialize()
        // has resolved every survivor into an open terminal, closing one and opening a
        // new terminal must reuse that slot (same client re-attaching its own session).
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize(); // restores slot 0 into an open terminal
        provider.releaseSlot(0);     // user closes it (detach, mapping kept)

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });
});

describe('live terminal close wiring (onDidOpenTerminal / onDidCloseTerminal)', () => {
    // Regression coverage for a real 09-verify bug: `releaseSlot` is pure and
    // unit-tested (see "reuses the lowest freed slot" above), but nothing ever
    // called it from a real VS Code close event — extension.ts never wired
    // `vscode.window.onDidCloseTerminal`. So closing and reopening a terminal
    // within one window session never freed a slot: every "New Terminal" after a
    // close minted a brand-new, ever-growing session instead of reattaching the
    // one just detached (found live: 5 open/kill cycles -> 5 distinct sessions on
    // the remote, not 1 reused slot). The fix correlates a live `vscode.Terminal`
    // back to its slot via the session name baked into `shellArgs` at open time.
    it('handleTerminalOpened + handleTerminalClosed round-trip frees the slot for reuse', async () => {
        const { provider } = makeProvider();
        const profile = await provider.provideTerminalProfile(); // slot 0
        const fakeTerminal = { creationOptions: optionsOf(profile) } as unknown as import('vscode').Terminal;

        provider.handleTerminalOpened(fakeTerminal);
        provider.handleTerminalClosed(fakeTerminal);

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('ignores a terminal that is not one of ours (no shellArgs / foreign session)', () => {
        const { provider } = makeProvider();
        const foreign = { creationOptions: { shellPath: '/bin/bash' } } as unknown as import('vscode').Terminal;
        expect(() => provider.handleTerminalOpened(foreign)).not.toThrow();
        expect(() => provider.handleTerminalClosed(foreign)).not.toThrow();
    });

    it('closing an unopened/unknown terminal is a no-op (does not free an unrelated slot)', async () => {
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // slot 0
        const unknown = { creationOptions: { shellPath: 'tmux', shellArgs: [] } } as unknown as import('vscode').Terminal;

        provider.handleTerminalClosed(unknown);

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1)); // 0 still open
    });
});

describe('restore mapping (per client, on reload)', () => {
    it('re-attaches mapped slots whose session survives and prunes the dead', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '2': name(2) } });
        const exec = fakeExec({ existing: [name(0)] }); // has-session: 0 present, 2 gone
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]); // only slot 0 re-opened
        expect(provider.mappedSlots()).toEqual([0]);          // slot 2 pruned
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
    });

    // THE FIELD BUG (fixed): "mapped AND attached" was read as "another machine holds
    // this", so restore was skipped and the user got a brand-new empty terminal while
    // their real work sat in a session they could no longer see. It is not another
    // machine: VS Code keeps a closed window's pty alive for its reconnection grace (3h
    // by default), so OUR OWN tmux client stays attached long after the window is gone.
    // The mapping is client-local, so anything in it was created by this machine —
    // reclaiming it with `-D` (which evicts the stale client and leaves the pane's
    // process running) is taking back what is ours. Observed live as session
    // `code-8282129a2247-0` running htop, orphan client stale by 158s.
    it('reclaims a mapped slot reported attached (our own stale pty, not another machine)', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]); // re-attached, not abandoned
        expect(opened[0].shellArgs).toContain('-D');          // evicting the stale client
        expect(provider.mappedSlots()).toEqual([0]);
    });

    // The no-steal invariant, unchanged and now stated precisely: it is about sessions
    // this machine does NOT own. An attached session absent from our mapping belongs to
    // another client, and re-attaching would mirror keystrokes into their live terminal.
    it('never touches an attached session this client does not own (no steal)', async () => {
        const state = fakeState({}); // nothing mapped — this session is not ours
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });

    // A plain restore must never carry `-D` — evicting a client is reserved for the
    // reclaim path, so an ordinary reattach can't kick a second machine off by accident.
    it('does not pass -D when re-attaching a detached session', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(opened[0].shellArgs).not.toContain('-D');
    });
});

describe('reconnect re-reconcile (initialize is idempotent, no duplicate tab)', () => {
    // A transient SSH reconnect re-fires resolve-success on the *same* extension
    // host, so extension.ts calls initialize() again ("refresh provider state"). A
    // slot already backing an open terminal in this window must not spawn a second,
    // mirrored tab: reopen() skips slots already in openSlots, so only genuinely-not-
    // open survivors/orphans are (re)opened on the second pass.
    it('does not re-open an already-open survivor when initialize() runs again', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize(); // first connect: restore slot 0 (opens once)
        await provider.initialize(); // reconnect: reconcile again — must not re-open

        expect(opened.map(targetSession)).toEqual([name(0)]); // opened exactly once
        expect(provider.mappedSlots()).toEqual([0]);
    });
});

describe('adoption (hand-off / reconciliation)', () => {
    it('re-attaches mapped, adopts detached-unmapped, leaves another client\'s attached', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), true)],
            existing: [name(0)], // mapped slot 0's session still exists
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        const openedSessions = opened.map(targetSession);
        expect(openedSessions).toContain(name(0)); // slot 0 re-attached (mapped)
        expect(openedSessions).toContain(name(1)); // slot 1 adopted (detached, unmapped)
        expect(openedSessions).not.toContain(name(2)); // slot 2 left (attached elsewhere)
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    // Previously asserted that a zero-window session is left to the reaper. That input
    // cannot occur: tmux destroys a session when its last window closes, so `list-sessions`
    // never reports `#{session_windows}` below 1 — verified against real tmux 3.4 across
    // every session state reproducible on a live server, including sessions whose shell had
    // exited. The old expectation therefore pinned behaviour for an impossible input while
    // reading as though it covered a real corpse case. Adoption is the correct handling of
    // the input regardless: attaching an (impossible) empty session is harmless, whereas the
    // guard re-imported a predicate already proven dead once in the reap decision.
    it('adopts a detached session regardless of window count (zero-window cannot occur)', async () => {
        const exec = fakeExec({ list: [row(name(1), false, 0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
        expect(provider.mappedSlots()).toEqual([1]);
    });
});

describe('explicit close kills the session (no invisible leftovers)', () => {
    // A terminal the user explicitly closes must leave nothing behind. The previous
    // design "tombstoned" the slot instead: the slot was excluded from restore AND
    // adoption while its tmux session went on running on the remote forever — reachable
    // by nothing, visible to no one, surviving every reload. That is precisely the zombie
    // this fork promises never to create, and it shipped. Observed in the field:
    //
    //   tmux slot 2: mapped=yes tombstoned=yes open=no attached=no windows=1
    //       -> skip (user-closed (tombstoned))
    //
    // with `code-bcb9aa492263-2` still alive in `tmux ls`, holding a live shell the user
    // could not get back — reported as "1 lost". Close now means kill, which is also what
    // closing a terminal means in stock open-remote-ssh; nothing survives to be skipped,
    // so the tombstone concept is gone entirely.

    /** Flush pending microtasks/timers (the close handler kills fire-and-forget). */
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));
    /** Every `kill-session` command the provider issued. */
    const kills = (exec: ReturnType<typeof fakeExec>): string[] =>
        exec.mock.calls.map(c => c[0]).filter(c => c.includes('kill-session'));

    /** Open slot 0 and hand back a `Terminal` double closed for `reason`. */
    async function openThenClose(reason: number | undefined, over: Parameters<typeof makeProvider>[0] = {}) {
        const made = makeProvider(over);
        const profile = await made.provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: reason === undefined ? undefined : { code: undefined, reason },
        } as unknown as import('vscode').Terminal;
        made.provider.handleTerminalOpened(term);
        made.provider.handleTerminalClosed(term);
        await flush();
        return made;
    }

    it('kills the tmux session when the user closes the terminal (reason 3)', async () => {
        const { exec, provider, state } = await openThenClose(3);

        expect(kills(exec)).toEqual([buildKillSession(name(0))]);
        // The mapping goes with it: leaving it would make the next reload try to restore a
        // session that no longer exists, costing a pointless has-session round-trip.
        expect(provider.mappedSlots()).toEqual([]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({});
    });

    // `onDidCloseTerminal` fires on *disposal*, for four distinct reasons — the
    // `TerminalExitReason` enum (upstream VS Code 1.71+): Unknown=0, Shutdown=1
    // "the window closed/reloaded", Process=2 "the shell process exited", User=3.
    // Only User is the user closing the terminal. Killing on Shutdown would destroy a
    // running Claude Code task every time the window closes — the exact opposite of what
    // this fork is for.
    it.each([
        [1, 'window shutdown/reload'],
        [2, 'shell process exit'],
        [0, 'unknown'],
    ])('never kills when the terminal closed for reason %i (%s)', async (reason) => {
        const { exec, provider } = await openThenClose(reason);

        expect(kills(exec)).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // still restorable on the next connect
    });

    // engines.vscode is ^1.70.2 and `exitStatus.reason` only exists from 1.71. On an older
    // host the close reason is unknowable, and the two possible mistakes are not
    // symmetric: wrongly keeping a session costs one stale terminal that the next reload
    // re-attaches, wrongly killing one destroys work that cannot be recovered. Keep it.
    it('never kills when the host reports no exit status at all (VS Code < 1.71)', async () => {
        const { exec, provider } = await openThenClose(undefined);

        expect(kills(exec)).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('frees the slot for reuse after an explicit close', async () => {
        const { provider } = await openThenClose(3);
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('survives a kill that fails on the remote without breaking the close path', async () => {
        // The session outliving a failed kill is the acceptable outcome: reconcile has no
        // tombstone to consult any more, so the next reload simply re-attaches it and the
        // user can see (and close) it again. Silently swallowing the failure is what must
        // not happen to the rest of the close handling.
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = await openThenClose(3, { exec });

        expect(provider.mappedSlots()).toEqual([]);
    });

    it('restores a mapped detached slot on reload even after an earlier user close', async () => {
        // The regression this whole change exists to prevent: a slot the user once closed
        // must never become permanently unreachable while its session is still alive.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('adopts a live detached orphan left behind by a previous version\'s tombstone', async () => {
        // Upgrade path for anyone already carrying the shipped bug: 1.0.5 persisted
        // `tmux.tombstonedSlots.v1`, and those slots are exactly the sessions stranded on
        // the remote. Reading the key at all would keep them stranded, so it is gone —
        // the orphan is adopted like any other, and the stale key is cleared on persist.
        const state = fakeState({ 'tmux.tombstonedSlots.v1': [1] });
        const exec = fakeExec({ list: [row(name(1), false)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
        expect(provider.mappedSlots()).toEqual([1]);
        expect(state.get('tmux.tombstonedSlots.v1')).toBeUndefined();
    });
});

describe('profile options (invisible + argv, no injection surface)', () => {
    it('returns tmux shellPath, the 02 argv builder output, and cwd', async () => {
        const { provider } = makeProvider({ historyLimit: 50000 });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe('tmux');
        expect(options.shellArgs).toEqual(
            buildAttachOrCreateArgv(name(0), CWD, undefined, { historyLimit: 50000 }),
        );
        expect(options.cwd).toBe(CWD);
    });

    // `isTransient: true` opted these terminals out of VS Code's terminal persistence, on
    // the reasoning that tmux owns lifetime so VS Code should keep its hands off. That is
    // true of the *session* but not of the *window*: the same persistence layer is what
    // restores split and group layout, so opting out silently threw away every split the
    // user had made. They came back as separate tabs on every reload — reported twice from
    // the field. VS Code reviving a terminal is harmless here anyway: it relaunches the
    // same `new-session -A` argv, which re-attaches the very session it left.
    it('does not opt out of VS Code terminal persistence (that is what restores splits)', async () => {
        const { provider } = makeProvider();
        expect(optionsOf(await provider.provideTerminalProfile()).isTransient).toBeUndefined();
    });

    it('falls back to a bare `tmux` on PATH when the probe resolved no path', async () => {
        const { provider } = makeProvider(); // no tmuxPath
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe('tmux');
    });

    it('launches tmux by the probe-resolved absolute path (nix / ~/.local/bin, not on the non-login PATH)', async () => {
        // VS Code spawns shellPath directly, not through a login shell, so a bare
        // `tmux` misses installs off the default PATH (nix profile, ~/.local/bin).
        // The bootstrap probe already resolved the absolute path via `command -v`;
        // the provider must launch that path.
        const tmuxPath = '/home/user/.nix-profile/bin/tmux';
        const { provider } = makeProvider({ tmuxPath });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe(tmuxPath);
    });

    it('uses the resolved tmux path for restored/adopted terminals too (reopen path)', async () => {
        // buildOptions backs both provideTerminalProfile *and* reopen; a restored
        // survivor must launch by the same absolute path, not a bare `tmux`.
        const tmuxPath = '/home/user/.local/bin/tmux';
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, tmuxPath });

        await provider.initialize();

        expect(opened[0]?.shellPath).toBe(tmuxPath);
    });

    it('defaults the history limit through to the 02 builder when unset', async () => {
        const { provider } = makeProvider();
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellArgs).toEqual(buildAttachOrCreateArgv(name(0), CWD));
    });

    it('titles the tab like a shell (workspace folder), never "tmux" (invisible UX)', async () => {
        const { provider } = makeProvider();
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.name).toBe('proj');
        expect(options.name).not.toContain('tmux');
    });

    it('persists the new slot→session mapping in workspaceState', async () => {
        const { provider, state } = makeProvider();
        await provider.provideTerminalProfile();
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
        expect(provider.mappedSlots()).toEqual([0]);
    });
});

describe('readMapping (malformed persisted state, defensive parsing)', () => {
    // The constructor loads the persisted slot->sessionName mapping through
    // `readMapping`, which must tolerate a hand-edited or corrupted
    // workspaceState blob (bad key, bad value) by dropping just the bad entry
    // rather than throwing or resurrecting garbage slots.
    it('drops a non-numeric key, a negative slot, a non-integer slot, and a non-string value; keeps the valid entry', async () => {
        const state = fakeState({
            [SLOT_MAPPING_STATE_KEY]: {
                'x': name(9),
                '-1': name(9),
                '1.5': name(9),
                '0': 42,
                '3': name(3),
            },
        });
        const exec = fakeExec({ existing: [name(3)] });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([3]);
    });

    it('treats a completely empty/missing persisted mapping as no survivors, without throwing', async () => {
        const { provider } = makeProvider({ state: fakeState({}) });
        expect(() => provider.mappedSlots()).not.toThrow();
        expect(provider.mappedSlots()).toEqual([]);
    });
});

describe('sessionExists (has-session stderr variants)', () => {
    // sessionExists reads MISSING_SESSION_RE against stderr (no exit code is
    // surfaced by exec). Every phrasing tmux actually uses for "not there" must
    // prune the mapping, not just the one variant exercised elsewhere
    // ("can't find session").
    it.each([
        `no server running on /tmp/tmux-1000/default`,
        `error connecting to /tmp/tmux-1000/default (No such file or directory)`,
    ])('prunes a mapped slot whose has-session reports: %s', async (stderr) => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                return { stdout: '', stderr: '' };
            }
            if (command.includes('has-session')) {
                return { stdout: '', stderr };
            }
            return { stdout: '', stderr: '' };
        });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([]); // pruned, not kept as a false survivor
    });
});

describe('folderName (tab title from a remote cwd, edge inputs)', () => {
    // folderName titles the tab after the workspace folder — must degrade
    // sanely for edge-case remote paths instead of producing an empty title.
    it.each([
        ['/home/user/proj/', 'proj'],       // trailing slash
        ['/', '/'],                          // root: no segment after stripping the slash
        ['', ''],                            // empty cwd: falls back to the whole (empty) path
        ['/home/user//proj///', 'proj'],     // multiple trailing slashes
    ])('titles cwd %s as %s', async (cwd, expected) => {
        const provider = new TmuxTerminalProvider({
            ctx: { hostKey: HOST, workspaceKey: WS, cwd },
            exec: fakeExec(),
            state: fakeState(),
            openTerminal: () => { /* not exercised */ },
            log: { info: vi.fn(), trace: vi.fn() },
        });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.name).toBe(expected);
    });
});

describe('slotFromCreationOptions (defensive parsing of shellArgs)', () => {
    // handleTerminalOpened parses the slot back out of `-s <name>` in
    // shellArgs. A malformed/foreign options object (here: "-s" present but as
    // the very last element, with no name following it) must resolve to
    // "not ours" rather than throwing or indexing past the array.
    it('does not throw when "-s" is the last shellArgs element with no value after it', () => {
        const { provider } = makeProvider();
        const dangling = { creationOptions: { shellPath: 'tmux', shellArgs: ['new-session', '-s'] } } as unknown as import('vscode').Terminal;

        expect(() => provider.handleTerminalOpened(dangling)).not.toThrow();
        // Not recognised as one of ours, so closing it must not free any slot.
        expect(() => provider.handleTerminalClosed(dangling)).not.toThrow();
    });
});

describe('coexisting with VS Code terminal persistence (the cost of restoring splits)', () => {
    // Dropping `isTransient` hands restore-on-reload back to VS Code, which is the only way
    // to get split layout back — but it means two things now restore the same slot: VS Code
    // reviving its persisted terminal, and this provider's reconcile. Both land on the same
    // `new-session -A`, so a duplicate is not a lost session — it is two tmux clients on one
    // session, mirroring each other's keystrokes and clamping the window to the smaller of
    // the two. Neither side can be made to win the race (VS Code revives a remote terminal
    // once the server connection is up, which is exactly when reconcile runs), so the
    // provider is written to be correct whichever arrives first.

    /** A `Terminal` double whose creationOptions name `slot`'s session. */
    const revived = (slot: number, dispose = vi.fn()) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose,
    } as unknown as import('vscode').Terminal);

    it('skips a slot VS Code has already revived', async () => {
        // VS Code won the race: its revived terminal is live before reconcile decides.
        // Re-attaching would put a second client on the same session.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [revived(0)] });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // still ours, just already on screen
    });

    it('still restores the slots VS Code did not revive', async () => {
        // Partial revive is the normal case: VS Code only persists terminals from ITS last
        // window, so a hand-off (or a slot it dropped) still needs reconcile.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [revived(0)] });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
    });

    it('ignores foreign terminals when seeding from the window', async () => {
        // A plain shell, or another workspace's session, must not reserve one of our slots.
        const foreign = { creationOptions: { shellArgs: ['-l'] } } as unknown as import('vscode').Terminal;
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [foreign] });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('disposes a revived terminal that arrives after reconcile already restored its slot', async () => {
        // Reconcile won the race, then VS Code's revive lands anyway. Left alone this is the
        // duplicate: two tabs, two tmux clients, one session, mirrored keystrokes.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });
        await provider.initialize();
        provider.handleTerminalOpened(revived(0)); // the terminal reconcile opened

        const dispose = vi.fn();
        provider.handleTerminalOpened(revived(0, dispose)); // the late duplicate

        expect(dispose).toHaveBeenCalled();
    });

    // The dangerous interaction: disposing a terminal fires onDidCloseTerminal, and VS Code
    // may well report that as a user close — which now KILLS the session. Discarding a
    // duplicate tab must never take the session down with it.
    it('never kills the session when discarding a duplicate', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec });
        await provider.initialize();
        provider.handleTerminalOpened(revived(0));

        const duplicate = {
            creationOptions: { shellArgs: ['new-session', '-A', '-s', name(0)] },
            exitStatus: { code: undefined, reason: 3 }, // VS Code reports it as a user close
            dispose: vi.fn(),
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(duplicate);
        provider.handleTerminalClosed(duplicate);
        await new Promise(res => setTimeout(res, 0));

        expect(exec.mock.calls.map(c => c[0]).filter(c => c.includes('kill-session'))).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // the surviving terminal keeps the slot
    });

    it('lets a genuinely new terminal on a freed slot through', async () => {
        // The duplicate guard keys off a slot that is currently held. Once the holder
        // closes, the same slot must be openable again — otherwise close-then-reopen breaks.
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // slot 0
        const first = revived(0);
        provider.handleTerminalOpened(first);
        provider.handleTerminalClosed(first);

        const dispose = vi.fn();
        provider.handleTerminalOpened(revived(0, dispose));

        expect(dispose).not.toHaveBeenCalled();
    });
});

describe('revive grace (letting VS Code go first, deterministically)', () => {
    // Seeding from the window only helps if VS Code's revive has actually landed by the
    // time reconcile looks. It has not, reliably: a remote terminal revives once the server
    // connection is up, which is the same moment reconcile starts. Losing that race is not
    // merely untidy now that `restore-takeover` passes tmux `-D` — reconcile would evict the
    // client VS Code just reconnected, leaving the user staring at a detached tab. So
    // reconcile waits a beat first, and the wait is a real (injectable) parameter rather
    // than an accident of scheduling.

    const revived = (slot: number) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose: vi.fn(),
    } as unknown as import('vscode').Terminal);

    it('waits for the grace period before reading the window', async () => {
        // The terminal is not there when initialize() is called; it appears during the wait,
        // exactly as a real revive does. Reconcile must see it and leave that slot alone.
        const terminals: import('vscode').Terminal[] = [];
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            listTerminals: () => terminals,
            reviveGraceMs: 20,
        });

        const done = provider.initialize();
        terminals.push(revived(0)); // VS Code's revive lands during the grace
        await done;

        expect(opened).toEqual([]);
    });

    it('restores normally once the grace has passed with nothing revived', async () => {
        // A fresh machine has nothing to revive, and must not be punished for waiting.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // THE 1.0.8 BUG, as a test. VS Code does not replay a revived terminal's stored
    // shellArgs — it calls provideTerminalProfile again — so a provider that answers with a
    // freshly allocated slot mints a brand-new session per revived terminal. Field log:
    // "2 re-attached" followed by "new slot 1", "new slot 2" a second later, leaving four
    // tabs where two belonged and two empty sessions the user had to close by hand.
    it('answers a revive with a queued session instead of minting a new one', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '3': name(3) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(3), false)], existing: [name(0), name(3)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 50 });

        const init = provider.initialize();
        // VS Code revives its two persisted terminals: two profile requests, no context.
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();
        await init;

        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(0), name(3)]);
        expect(opened).toEqual([]); // the queue was consumed, so nothing is opened on top
    });

    // THE FIELD BUG a fixed grace cannot fix (report of 2026-07-24, 04:19 log, v1.0.9).
    // Two split terminals, reload, and four tabs came back: two unsplit, two split.
    //
    //   04:19:28.670  tmux terminals: 0 to re-attach, 2 to reclaim, ...   <- queue built
    //   04:19:31.172  tmux terminals: opened 2 session(s) VS Code did not restore
    //   04:19:33.450  tmux terminal: new slot 2 (...)   <- VS Code's revive, 2.3s too late
    //   04:19:34.038  tmux terminal: new slot 3 (...)
    //
    // The queue was handed out correctly; it was just *closed too early*. VS Code revives
    // when the workbench finishes restoring, which on a real remote is seconds after our
    // probes finish — so the 2.5s timer expired, the drain opened both sessions itself
    // (as plain unsplit tabs), and the revive that arrived next found an empty queue and
    // minted two brand-new sessions with the restored split layout wrapped around them.
    //
    // No zombies (all four tabs were attached to real sessions), but a duplicate is a
    // duplicate. The wait must end on the *claims*, not on a clock: the timer is only a
    // backstop for a revive that never comes.
    it('waits for a revive that lands long after the fixed grace would have fired', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            // Attached, because the closed window's pty outlives it — hence "to reclaim".
            list: [row(name(0), true), row(name(1), true)],
            existing: [name(0), name(1)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 2000 });

        const init = provider.initialize();
        // The workbench takes its time: far past the grace, as in the log above.
        await new Promise(resolve => setTimeout(resolve, 40));
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();
        await init;

        // Both revives get their own session back...
        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(0), name(1)]);
        // ...and nothing is opened on top of them, so two tabs, not four.
        expect(opened).toEqual([]);
    });

    // FOLLOW-UP FROM THE SAME RIG, on v1.1.0. The duplicate was gone — two sessions, two
    // tabs — but the second terminal took eleven seconds to appear:
    //
    //   46.868  tmux terminals: 2 to re-attach, ...
    //   48.386  tmux terminal: slot 0 claimed from the restore queue   <- one revive, 1.5s in
    //   59.402  tmux terminals: no revive after 10000ms, opening 1 queued session(s) directly
    //
    // VS Code revived ONE of the two persisted terminals, and waiting for *all* of them meant
    // the odd one out paid the full backstop. But the first claim is itself the answer: revive
    // is demonstrably running, and revives arrive in a burst (0.6s apart in the earlier log).
    // So once anything has been claimed, a short quiet period is enough to conclude the burst
    // is over — the long deadline is only for a revive that never starts at all.
    it('stops waiting a beat after the last claim instead of holding for the deadline', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            reviveGraceMs: 5,
            // A deadline long enough that reaching it is unmistakable in the elapsed time.
            reviveDeadlineMs: 5000,
            reviveQuietMs: 30,
        });

        const startedAt = Date.now();
        const init = provider.initialize();
        // VS Code revives exactly one of the two, as in the log above.
        const first = await provider.provideTerminalProfile();
        await init;
        const elapsed = Date.now() - startedAt;

        expect(targetSession(optionsOf(first))).toBe(name(0));
        // The unclaimed one still gets its terminal...
        expect(opened.map(targetSession)).toEqual([name(1)]);
        // ...without waiting out the backstop, which is what the user actually felt.
        expect(elapsed).toBeLessThan(1500);
    });

    // Each new claim has to re-arm the quiet period, or a burst slower than one quiet window
    // would be cut off half-way and the remaining sessions opened as duplicates of terminals
    // VS Code was still in the middle of reviving.
    it('re-arms the quiet period on every claim so a slow burst is not cut off', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1), '2': name(2) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false)],
            existing: [name(0), name(1), name(2)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 5000, reviveQuietMs: 60,
        });

        const init = provider.initialize();
        const claimed: string[] = [];
        // Three revives, each landing after a gap shorter than the quiet window but well
        // past the point a single un-rearmed window would have expired.
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 40));
            claimed.push(targetSession(optionsOf(await provider.provideTerminalProfile())));
        }
        await init;

        expect(claimed).toEqual([name(0), name(1), name(2)]);
        expect(opened).toEqual([]); // nothing opened on top of a revive still in progress
    });

    // The backstop must still fire, or a mapping with no revive behind it (persistence off,
    // or a cold start that revived nothing) would leave the user staring at no terminals
    // while their sessions sit alive on the remote.
    it('gives up on the revive at the deadline and opens the queue itself', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 30 });

        await provider.initialize(); // no profile request ever arrives

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // A reload *within* the reconnection grace reconnects the existing pty instead of
    // relaunching it, so that terminal never calls the provider — the queue would never
    // empty and the wait would burn its full deadline for nothing. Seeing the slot land in
    // the window has to end the wait just as a claim does.
    it('ends the wait when a revived terminal appears without a profile request', async () => {
        const terminals: import('vscode').Terminal[] = [];
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            listTerminals: () => terminals,
            reviveGraceMs: 5,
            // Long enough that finishing quickly can only mean the window was observed.
            reviveDeadlineMs: 5000,
        });

        const init = provider.initialize();
        setTimeout(() => terminals.push(revived(0)), 30);
        await init;

        expect(opened).toEqual([]);
    });

    // Hand-off has nothing of ours to revive: the sessions come from the remote (adopt),
    // not from this client's mapping, so there is no persisted terminal coming for them and
    // waiting on one would just delay the terminals for the whole deadline.
    it('does not wait on a revive for sessions adopted from another machine', async () => {
        const state = fakeState(); // empty mapping — a different machine created these
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 5000 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('opens only what the revive left unclaimed', async () => {
        // VS Code persisted one terminal, we have two sessions: the odd one out still needs
        // a terminal, or a session goes unreachable.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '3': name(3) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(3), false)], existing: [name(0), name(3)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        const init = provider.initialize();
        const first = await provider.provideTerminalProfile();
        await init;

        expect(targetSession(optionsOf(first))).toBe(name(0));
        expect(opened.map(targetSession)).toEqual([name(3)]);
    });

    it('opens everything when there is nothing to revive (hand-off to a fresh machine)', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // Once the queue is empty the provider is back to ordinary allocation — a user opening a
    // terminal after restore has settled must get a NEW session, not a second view of one.
    it('mints a new session once the queue is empty', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 0 });

        await provider.initialize();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    // A reconnect re-plans. Entries queued by the previous pass name slots that already have
    // terminals, and handing one out would put a second client on a live session.
    it('rebuilds the queue from scratch on a reconnect', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize(); // slot 0 restored, queue drained
        await provider.initialize(); // reconnect

        expect(opened.map(targetSession)).toEqual([name(0)]); // not restored twice
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('probe failures must not be read as "the session is gone"', () => {
    // `refreshRemote` already refuses to treat an empty list-sessions as proof of absence,
    // because the probe degrades to "no sessions" when the channel fails — one blip would
    // otherwise wipe every mapping. The narrower `has-session` probe that settles existence
    // had the opposite habit: it caught the exec rejection and reported "gone", so the exact
    // blip the first guard was written to survive still pruned the whole mapping one slot at
    // a time. A mapping is client-local and is the only record of which session belongs to
    // which slot; losing it strands live work behind an adoption that may never happen.

    it('keeps the mapping when the existence probe cannot be delivered', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('has-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' }; // list-sessions degrades to "saw nothing"
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 0 });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([0]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
    });

    it('still prunes when the probe is delivered and answers "no such session"', async () => {
        // The distinction has to cut both ways, or a genuinely dead mapping lives forever and
        // every reconnect spawns a terminal onto nothing.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [], existing: [] }); // reachable, session absent
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([]);
        expect(opened).toEqual([]);
    });

    it('does not queue a restore for a slot whose existence is unknown', async () => {
        // Keeping the mapping is right; opening a terminal onto a session we could not
        // confirm is not — `-A` would silently create an empty new one under that name.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('has-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened).toEqual([]);
    });
});

describe('a reconnect is not a revive', () => {
    // The restore queue exists to be consumed by VS Code reviving persisted terminals, which
    // only happens when a window is (re)built. A reconnect — the SSH link dropped and came
    // back, same window, same tabs — produces no revive calls at all, so holding the queue
    // open there just leaves a trap: the user's next "New Terminal" would silently become a
    // re-attach instead of the new session they asked for.

    it('drains immediately on a refresh instead of waiting for a revive', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        // A grace long enough that a test which waited for it would time out first.
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 60_000 });

        await provider.initialize({ awaitRevive: false });

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('leaves no queue for a later new terminal to be answered from', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 60_000 });

        await provider.initialize({ awaitRevive: false });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('window reload', () => {
    // A reload rebuilds the window: the extension host restarts, workspaceState survives, and
    // VS Code restores its terminals — by EITHER reconnecting the still-live remote pty
    // (inside the reconnection grace, no provider call) OR relaunching, which calls the
    // profile provider. Both happen, sometimes in the same reload, and each needs a different
    // half of the machinery: the pty reconnect is caught by reading the window, the relaunch
    // by the restore queue.

    const revived = (slot: number) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose: vi.fn(),
    } as unknown as import('vscode').Terminal);

    it('handles a reload that reconnects one pty and relaunches the other', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        // Slot 0's pty came back on its own; slot 1's did not.
        const { provider } = makeProvider({
            state, exec, opened, reviveGraceMs: 50,
            listTerminals: () => [revived(0)],
        });

        const init = provider.initialize();
        const relaunched = await provider.provideTerminalProfile(); // VS Code relaunching slot 1
        await init;

        expect(targetSession(optionsOf(relaunched))).toBe(name(1));
        expect(opened).toEqual([]); // slot 0 was already on screen, slot 1 was claimed
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    it('does not resurrect a terminal the user closed before reloading', async () => {
        // The close killed the session and dropped the mapping, so a reload has nothing to
        // restore for that slot — and must not invent one.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [], existing: [] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });

    // Reconnect storms are real (a flaky link re-resolves repeatedly), and each resolve
    // re-plans. A drain scheduled by an earlier pass must not fire into the queue a later
    // pass is still building — it would hand out slots against a half-finished decision.
    it('never lets a stale pass drain the queue of a newer one', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 30 });

        const first = provider.initialize();   // will try to drain after 30ms
        const second = provider.initialize();  // supersedes it
        await Promise.all([first, second]);

        expect(opened.map(targetSession)).toEqual([name(0)]); // opened once, not twice
    });
});

describe('races', () => {
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));

    // R1. VS Code reviving several terminals asks for several profiles at once. Allocation
    // read the free slot, then AWAITED a remote probe before recording the claim — so two
    // concurrent calls both read "0 is free", both awaited, and both took slot 0. Two
    // terminals on one tmux session: shared view, mirrored keystrokes. The window between
    // choosing a slot and claiming it has to contain no await at all.
    it('gives concurrent profile requests distinct slots', async () => {
        const { provider } = makeProvider();

        const profiles = await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);

        const slots = profiles.map(p => targetSession(optionsOf(p)));
        expect(new Set(slots).size).toBe(3);
        expect(slots.sort()).toEqual([name(0), name(1), name(2)].sort());
    });

    it('gives concurrent revive requests distinct queued sessions', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(1), false)], existing: [name(0), name(1)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 50 });

        const init = provider.initialize();
        const profiles = await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);
        await init;

        expect(new Set(profiles.map(p => targetSession(optionsOf(p)))).size).toBe(2);
    });

    // R2. Closing a terminal kills its session, but the close handler is synchronous so the
    // kill is in flight when it returns — and the slot is free again immediately. Open a new
    // terminal fast enough and `new-session -A` on the reused name races the `kill-session`
    // still travelling to the remote. Lose that race and the brand-new terminal's session is
    // destroyed under it. A slot with a kill in flight is not free yet.
    it('does not reuse a slot whose kill is still in flight', async () => {
        let releaseKill!: () => void;
        const killGate = new Promise<void>(res => { releaseKill = res; });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                await killGate;
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ exec });

        const profile = await provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term); // kill starts, does not finish
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));

        releaseKill();
        await flush();
    });

    it('frees the slot again once the kill has landed', async () => {
        // The guard must be temporary: a slot held forever by a completed kill would push
        // every later terminal to a higher number for the life of the window.
        const { provider } = makeProvider();
        const profile = await provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term);
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('frees the slot even when the kill fails', async () => {
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ exec });
        const profile = await provider.provideTerminalProfile();
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term);
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    // R3. Every mutation persists the whole derived record. Two overlapping writes can land
    // out of order, leaving workspaceState holding the older snapshot — and that record is
    // the only thing telling the next window which session belongs to which slot.
    it('persists slot state in order under concurrent writes', async () => {
        const writes: Array<Record<string, string>> = [];
        const state = {
            keys: (): string[] => [],
            get: (_key: string, def?: unknown): unknown => def,
            update: async (key: string, value: unknown): Promise<void> => {
                if (key === SLOT_MAPPING_STATE_KEY) {
                    // Invert the natural completion order: an unserialised implementation
                    // lets the earlier, smaller snapshot land last.
                    const delay = 20 - writes.length * 10;
                    await new Promise(res => setTimeout(res, Math.max(delay, 0)));
                    writes.push(value as Record<string, string>);
                }
            },
        };
        const { provider } = makeProvider({ state });

        await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);
        await flush();

        expect(Object.keys(writes[writes.length - 1])).toHaveLength(2); // newest snapshot wins
    });
});

describe('hand-off across machines (PC -> laptop -> PC)', () => {
    // The scenario this fork exists for, end to end: start two things on the PC, move to the
    // laptop and start two more, close the laptop, stop the PC, come back to the PC — all
    // four should still be there. The PC restores the two it owns (they are in ITS
    // client-local mapping) and *adopts* the two the laptop left behind (unmapped here, but
    // unheld on the remote, and in this workspace's namespace).

    it('lands a second machine on fresh slots instead of stealing the first machine\'s', async () => {
        // Laptop connecting while the PC holds slots 0 and 1: no mapping of its own, and both
        // remote sessions attached. Re-attaching either would mirror keystrokes into the PC.
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), true)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened, reviveGraceMs: 0 });

        await provider.initialize();
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();

        expect(opened).toEqual([]); // nothing adopted — both are held
        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(2), name(3)]);
    });

    it('restores its own two and adopts the other machine\'s two on return', async () => {
        // Back at the PC: it maps 0 and 1; the laptop's 2 and 3 are detached on the remote.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false), row(name(3), false)],
            existing: [name(0), name(1), name(2), name(3)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0), name(1), name(2), name(3)]);
        expect(provider.mappedSlots()).toEqual([0, 1, 2, 3]);
    });

    // The honest limit of the above. Closing a laptop LID does not close its window: the
    // remote pty (and the tmux client inside it) survives for VSCODE_RECONNECTION_GRACE_TIME,
    // 3h by default, so those sessions still read as attached. Adopting them anyway would be
    // stealing from a machine that may be seconds from waking up, so they are left alone
    // until that grace expires and their clients actually die.
    it('leaves the other machine\'s sessions alone while its clients are still attached', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), true), row(name(3), true)],
            existing: [name(0), name(1)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0), name(1)]);
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    it('adopts them on a later connect, once those clients are gone', async () => {
        // Same machine, same state, one connect later: the laptop's grace has expired.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false), row(name(3), false)],
            existing: [name(0), name(1), name(2), name(3)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toContain(name(2));
        expect(opened.map(targetSession)).toContain(name(3));
    });
});
