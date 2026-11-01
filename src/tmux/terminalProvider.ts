import * as vscode from 'vscode';
import {
    buildAttachOrCreateArgv,
    buildHasSession,
    buildKillSession,
    buildListSessions,
    parseListSessions,
    sessionName,
    sessionSlot,
} from './tmuxSession';
import { decideSlotAction, describeSlot, type SlotInput } from './slotState';

// The VS Code-facing heart of the fork: a terminal-profile provider that backs
// each integrated terminal with a tmux session (`tmuxSession.ts` — the ONLY place
// tmux command lines are built; this module never concatenates a tmux string).
// Its whole job is deciding *which slot* a terminal maps to, so the two hard
// invariants hold:
//
//   * Invisible — profiles are plain `{shellPath:'tmux', shellArgs, cwd}`, the tab
//     is titled after the workspace folder (never "tmux"); no tmux UI (Route A, see
//     docs/idea/tmux-approach.md). The one settings write in the whole layer —
//     `terminal.integrated.defaultProfile.linux`, Workspace-scoped, only when the user
//     has no default at any scope — lives in `extension.ts`'s
//     `reconcileDefaultTerminalProfile`, not here.
//   * No zombies / no stealing — a *new* terminal takes the lowest slot not open
//     in this window and not currently attached by another client on the remote,
//     so a second client (laptop while the PC is attached) lands on a fresh slot
//     instead of -A-attaching into the PC's session. On reload we re-attach this
//     client's own mapped survivors and *adopt* detached orphans (hand-off), but
//     never touch a session another client holds.
//
// Everything is dependency-inverted (D in SOLID): the remote command runner
// (`RemoteExec`), the persistence (`vscode.Memento`), the terminal opener, and the
// logger are all injected, so the allocation/restore/adoption logic is pure and
// unit-testable with no real ssh2.
//
// Terminal close has exactly two meanings, and they are decided by `TerminalExitReason`:
//
//   * the *window* went away (shutdown/reload) or the shell exited — detach only. The
//     session lives on in the tmux server; that is the whole close-PC/open-laptop use case.
//   * the *user* closed the terminal (reason User) — `kill-session`. Closing a terminal
//     means closing it, exactly as in stock open-remote-ssh, and anything less leaves a
//     session running on the remote that nothing will ever show again. An earlier version
//     "tombstoned" such slots instead (skipping them in restore *and* adoption while the
//     session kept running); that shipped as a permanent invisible zombie, reported from
//     the field as "1 lost". Session death is otherwise a process exiting
//     (`remain-on-exit off`, 02); empty leftovers are cleaned by the reaper
//     (`sessionReaper.ts`), not here.

/** The single remote-exec capability the provider needs. Matches the shape of
 * `SSHConnection#exec` (whose extra optional params are compatible) but named as
 * its own abstraction so this module never imports `ssh2`/`ssh`. No exit code is
 * surfaced — command status is read from stdout/stderr, exactly as tmux reports. */
export type RemoteExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** Open a VS Code terminal for a restored/adopted session. Injected (rather than
 * calling `vscode.window.createTerminal` inline) so restore/adoption orchestration
 * is unit-testable. The production wiring passes a thin `createTerminal` adapter. */
export type OpenTerminal = (options: vscode.TerminalOptions) => void;

/** The terminals currently open in this window. Injected for the same reason as
 * {@link OpenTerminal}; production passes `() => vscode.window.terminals`. */
export type ListTerminals = () => readonly vscode.Terminal[];

/** The narrow slice of `Log` this module uses (ISP) — one-line invisible-UX logs. */
export interface TmuxLog {
    info(message: string): void;
    trace(message: string): void;
}

/** The resolved (host, workspace) this provider serves. Slot → session name is a
 * pure function of these, so the mapping is stable across reconnects. */
export interface TmuxSessionContext {
    /** Stable host identity (e.g. the resolved hostname) — half of the session hash. */
    readonly hostKey: string;
    /** Remote workspace path — the other half of the session hash. */
    readonly workspaceKey: string;
    /** Remote working directory new sessions start in (workspace folder). */
    readonly cwd: string;
}

/** Collaborators + config for a `TmuxTerminalProvider`. */
export interface TmuxTerminalDeps {
    readonly ctx: TmuxSessionContext;
    readonly exec: RemoteExec;
    /** Client-local persistence — `context.workspaceState` (pattern:
     * `remoteLocationHistory.ts`). Client-local is exactly the wanted semantics:
     * each machine restores *its* terminals, not a shared set. */
    readonly state: vscode.Memento;
    readonly openTerminal: OpenTerminal;
    /** The window's current terminals, read at reconcile time so slots VS Code has already
     * revived from its own persistence are not restored a second time. Defaults to "none",
     * which is the correct answer for a window that has no persistence to revive from. */
    readonly listTerminals?: ListTerminals;
    readonly log: TmuxLog;
    /** Scrollback lines for new sessions (`remote.SSH.tmux.historyLimit`, 05).
     * Undefined → the session model's default (50000). */
    readonly historyLimit?: number;
    /** Absolute path to the remote tmux binary, as resolved by the bootstrap probe
     * (`command -v tmux`, see `tmuxBootstrap.ts`'s `TmuxCapability.path`). Used as
     * the launched terminal's `shellPath` so VS Code invokes tmux by absolute path.
     * VS Code spawns `shellPath` directly, not through a login shell, so a bare
     * `tmux` misses installs off the default PATH (nix profile, `~/.local/bin`) and
     * fails with a tmux-naming spawn error. Undefined → fall back to a bare `tmux`
     * on PATH (probe printed no path line, or an exotic build). */
    readonly tmuxPath?: string;
    /** How long reconcile waits for VS Code to revive its own persisted terminals before
     * deciding anything ({@link REVIVE_GRACE_MS}). Injectable so tests need not sleep. */
    readonly reviveGraceMs?: number;
    /** Backstop for the claim-driven wait ({@link REVIVE_DEADLINE_MS}). Injectable so tests
     * need not sleep. */
    readonly reviveDeadlineMs?: number;
    /** Quiet period that ends the wait once a revive has started ({@link REVIVE_QUIET_MS}).
     * Injectable so tests need not sleep. */
    readonly reviveQuietMs?: number;
}

/**
 * How long the restore queue stays open for VS Code to claim from.
 *
 * These terminals are not `isTransient`, so VS Code persists them and restores split/group
 * layout — the thing an extension cannot reproduce, since there is no API to *read* a
 * terminal's split group. The catch, learned the hard way in the field: VS Code does not
 * replay the stored `shellArgs` when it revives an extension-profile terminal. It calls
 * {@link TerminalProfileProvider.provideTerminalProfile} again. A provider that answers
 * that with a freshly allocated slot mints a brand-new tmux session per revived terminal,
 * which is exactly what 1.0.8 shipped:
 *
 *   tmux terminals: 2 re-attached, ...     <- reconcile restored slots 0 and 3
 *   tmux terminal: new slot 1 (...)        <- VS Code's revive, 1.3s later
 *   tmux terminal: new slot 2 (...)        <- and again
 *
 * Four tabs, two of them empty new sessions, and the user closing three of them by hand.
 *
 * So restore does not create terminals up front. It builds a queue of sessions that want a
 * terminal and lets VS Code's revive *consume* it — each revive call gets the next session
 * to restore, so the layout comes from VS Code and the sessions come from here. Whatever is
 * still unclaimed once this window closes is opened directly, which covers a machine with
 * nothing to revive (hand-off) and a VS Code that revived fewer terminals than we have
 * sessions.
 *
 * This value is only the *floor* — the beat reconcile waits before reading the window at
 * all. Closing the queue on a fixed timer was itself the field bug of 1.0.9: see
 * {@link REVIVE_DEADLINE_MS}.
 */
export const REVIVE_GRACE_MS = 2500;

/**
 * Backstop for the wait that a claim ends.
 *
 * A *fixed* grace cannot be right, because the two things being ordered are not related:
 * this queue is final when our remote probes finish, while VS Code revives when the
 * workbench finishes restoring — which on a real remote is seconds later, and bounded by
 * nothing we can see. Field report (v1.0.9, two split terminals, one reload):
 *
 *   28.670  tmux terminals: 0 to re-attach, 2 to reclaim, ...   <- queue final
 *   31.172  tmux terminals: opened 2 session(s) VS Code did not restore
 *   33.450  tmux terminal: new slot 2 (...)   <- the revive, 2.3s past the grace
 *   34.038  tmux terminal: new slot 3 (...)
 *
 * Four tabs where two belonged: the drain opened the two survivors as plain tabs, then the
 * revive found an empty queue and minted two new sessions — with the restored split layout
 * wrapped around the *wrong* pair. Not zombies (every tab held a live session), but exactly
 * the duplicate the queue exists to prevent. Raising 2500 would only move the goalposts.
 *
 * So the wait ends on *evidence* instead: every queued slot either claimed through
 * {@link TmuxTerminalProvider.provideTerminalProfile} or observed in the window (a reload
 * inside the reconnection grace reconnects the pty without asking for a profile). This
 * deadline is only reached when a revive is genuinely not coming — VS Code persistence off,
 * or a cold start that revived nothing — and then the drain opens the queue itself. It is
 * therefore a *worst case for a rare path*, not a latency every reload pays, which is why
 * it can afford to be this long.
 */
export const REVIVE_DEADLINE_MS = 10000;

/**
 * Quiet period that ends the wait once a revive has actually started.
 *
 * The deadline above is the answer to "is a revive coming at all?", and it is the wrong
 * question to keep asking after the first one lands. VS Code revives its persisted terminals
 * in a burst — 0.6s apart in the 1.0.9 log — and it may well revive *fewer* than we have
 * sessions, because it only persisted the terminals from its own last window. Waiting for
 * every queued slot then means the odd one out pays the full backstop, which is the second
 * report from the same rig, on v1.1.0:
 *
 *   46.868  tmux terminals: 2 to re-attach, ...
 *   48.386  tmux terminal: slot 0 claimed from the restore queue   <- one revive, 1.5s in
 *   59.402  tmux terminals: no revive after 10000ms, opening 1 session(s) directly
 *
 * Correct — two sessions, two tabs, no duplicate — but the second terminal took eleven
 * seconds to appear. The first claim is itself the evidence the deadline was waiting for:
 * revive is running, so all that remains is to notice the burst has finished. Every claim
 * re-arms this window, so a slow burst is never cut off half-way (which would open duplicates
 * of terminals VS Code was still mid-revive on).
 */
export const REVIVE_QUIET_MS = 2000;

/** How often the wait re-reads the window. Only the window needs polling — a claim ends the
 * wait by emptying the queue, and both are checked on the same tick. */
const REVIVE_POLL_MS = 250;

/** workspaceState key holding the client-local `slot → sessionName` mapping.
 * Versioned so the shape can evolve without colliding with old data. */
export const SLOT_MAPPING_STATE_KEY = 'tmux.slotSessions.v1';

/** workspaceState key written by 1.0.5's tombstone mechanism. Never *read* — the slots it
 * lists are precisely the sessions that version stranded on the remote, so honouring it
 * would keep them stranded. It is cleared on the next {@link TmuxTerminalProvider#persist}
 * so an upgraded client sheds the stale data instead of carrying it forever. */
const LEGACY_TOMBSTONE_STATE_KEY = 'tmux.tombstonedSlots.v1';

/** Fallback `shellPath` when the probe resolved no absolute tmux path — a bare
 * `tmux` on PATH (see {@link TmuxTerminalDeps.tmuxPath} for why a path is preferred). */
const TMUX_BIN = 'tmux';

/** stderr markers that mean "that session/server is not there" (no exit code is
 * surfaced by `exec`, so existence is read from the message). */
const MISSING_SESSION_RE = /can't find|no server running|no such|error connecting/i;

/** One of this workspace's sessions as seen on the remote right now. */
interface RemoteSession {
    readonly slot: number;
    readonly name: string;
    readonly attached: boolean;
    readonly windows: number;
}

export class TmuxTerminalProvider implements vscode.TerminalProfileProvider {
    private readonly ctx: TmuxSessionContext;
    private readonly exec: RemoteExec;
    private readonly state: vscode.Memento;
    private readonly openTerminal: OpenTerminal;
    private readonly listTerminals: ListTerminals;
    private readonly log: TmuxLog;
    private readonly historyLimit?: number;
    /** Resolved `shellPath` for every launched terminal — the probe's absolute tmux
     * path when known, else a bare `tmux` on PATH ({@link TMUX_BIN}). */
    private readonly tmuxPath: string;
    /** Grace period before reconcile reads the window (see {@link REVIVE_GRACE_MS}). */
    private readonly reviveGraceMs: number;
    /** Backstop for the claim-driven wait (see {@link REVIVE_DEADLINE_MS}). */
    private readonly reviveDeadlineMs: number;
    /** Quiet period that ends the wait after a revive has started (see {@link REVIVE_QUIET_MS}). */
    private readonly reviveQuietMs: number;

    /** Persisted client-local mapping of slot → session name (survives reloads). */
    private readonly mapping: Map<number, string>;
    /** Slots currently backing an open terminal in *this* window. */
    private readonly openSlots = new Set<number>();
    /** Slots whose `kill-session` is still in flight. Not free for reuse yet: a reused name
     * would let `new-session -A` race the kill and lose the brand-new session
     * ({@link killSlotSession}). */
    private readonly killingSlots = new Set<number>();
    /** Slots a *remote* session is currently attached to (any client) — the
     * no-steal guard, refreshed from `list-sessions` at connect and on each create. */
    private attachedRemoteSlots = new Set<number>();
    /** Slots held for connect-time restore/adoption. Seeded synchronously from the
     * persisted mapping in the constructor — *before* {@link initialize}'s first
     * `await` — so a `provideTerminalProfile` that races (or precedes) `initialize`
     * cannot hand a survivor's slot to a brand-new terminal: that produced a second,
     * mirrored tab on slot 0. Drained once reconciliation has resolved every survivor
     * into `openSlots` (or pruned it), so a later close-then-reopen can still reuse a
     * slot ({@link releaseSlot}). */
    private readonly reservedSlots: Set<number>;
    /** Sessions that want a terminal, in slot order, waiting to be claimed — by VS Code's
     * revive calling {@link provideTerminalProfile}, or failing that by
     * {@link drainPendingRestores}. See {@link REVIVE_GRACE_MS} for why restore hands these
     * out instead of creating the terminals itself.
     *
     * `revivable` records whether the entry came from THIS client's own mapping. Only those
     * can have a persisted VS Code terminal behind them, so only those are worth waiting on
     * ({@link awaitRevive}) — a session adopted from another machine has none, and waiting
     * would just delay a hand-off for the whole deadline. */
    private readonly pendingRestores: Array<{ slot: number; takeOver: boolean; revivable: boolean }> = [];
    /** Tail of the serialised persist chain — see {@link persist}. */
    private persistChain: Promise<void> = Promise.resolve();
    /** Backing store for {@link initialized} — resolves when the queue above is final. */
    private planning: Promise<void> = Promise.resolve();
    /** The whole of {@link initialize}, queue drained. Returned to callers, awaited by tests. */
    private reconciliation: Promise<void> = Promise.resolve();

    constructor(deps: TmuxTerminalDeps) {
        this.ctx = deps.ctx;
        this.exec = deps.exec;
        this.state = deps.state;
        this.openTerminal = deps.openTerminal;
        this.listTerminals = deps.listTerminals ?? ((): readonly vscode.Terminal[] => []);
        this.log = deps.log;
        this.historyLimit = deps.historyLimit;
        this.tmuxPath = deps.tmuxPath ?? TMUX_BIN;
        this.reviveGraceMs = deps.reviveGraceMs ?? REVIVE_GRACE_MS;
        this.reviveDeadlineMs = deps.reviveDeadlineMs ?? REVIVE_DEADLINE_MS;
        this.reviveQuietMs = deps.reviveQuietMs ?? REVIVE_QUIET_MS;
        this.mapping = readMapping(deps.state);
        this.reservedSlots = new Set(this.mapping.keys());
    }

    /** Resolves once the restore *decision* is made — the queue in {@link pendingRestores}
     * is final and can be consumed. Deliberately NOT the whole of {@link initialize}, which
     * also waits out the revive window: a revive call arriving in that window is precisely
     * what the queue exists to serve, so blocking it until the window closed would deadlock
     * the two against each other. An already-resolved promise until `initialize` is first
     * invoked; assigned synchronously at `initialize` entry, before its first `await`. */
    get initialized(): Promise<void> {
        return this.planning;
    }

    /**
     * Connect/reload reconciliation. Re-attaches this client's mapped survivors,
     * prunes dead mappings, then adopts any detached-but-live orphan session of
     * this workspace that no client holds (hand-off: PC closed → laptop takes over;
     * reconciliation: PC reconnects → its own + the laptop's orphan). Attached
     * sessions of another client are left strictly untouched (no steal, no mirror).
     */
    initialize(options: { awaitRevive?: boolean } = {}): Promise<void> {
        // `awaitRevive` is false for a reconnect (`TmuxTerminalLayer#refresh`): the link
        // dropped and came back on the same window with the same tabs, so VS Code has
        // nothing to revive and never calls the provider. Holding the queue open there would
        // only leave a trap — the user's next "New Terminal" would silently become a
        // re-attach instead of the new session they asked for.
        const grace = options.awaitRevive === false ? 0 : this.reviveGraceMs;
        // Publish the gate *before* the first `await` (assignment is synchronous, so
        // extension.ts wiring `initialize()` ahead of registering the provider arms the
        // gate before any `provideTerminalProfile`).
        this.planning = this.plan();
        // Then hold the queue open for VS Code's revive and open whatever it did not claim.
        // `finally` so a failed probe never wedges the connect-time slot reservations on,
        // letting a later close-then-reopen reuse a slot ({@link releaseSlot}).
        this.reconciliation = this.planning
            .then(() => this.awaitRevive(grace))
            .then(() => this.drainPendingRestores())
            .finally(() => this.reservedSlots.clear());
        return this.reconciliation;
    }

    /**
     * Hold the restore queue open until VS Code's revive has accounted for it, or until the
     * backstop says it is not coming. See {@link REVIVE_DEADLINE_MS} for why this cannot be a
     * plain timer — closing the queue on a clock is what put four tabs on screen in 1.0.9.
     *
     * A queued slot is accounted for two ways, and both are checked on the same tick:
     * `provideTerminalProfile` shifting it out of the queue (a relaunched terminal asking for
     * its profile), or it turning up in the window (a reload inside the reconnection grace
     * reconnects the pty and never asks). Neither is a timing assumption.
     *
     * Two different clocks, for two different questions ({@link REVIVE_QUIET_MS}): until the
     * first slot is accounted for the question is "is a revive coming at all?", answered by
     * the long backstop; after it, "has the burst finished?", answered by a short quiet period
     * that every further claim re-arms. VS Code can revive fewer terminals than we have
     * sessions, so waiting for the whole queue would make the odd one out pay the backstop.
     */
    private async awaitRevive(grace: number): Promise<void> {
        if (grace <= 0) {
            return; // reconnect: same window, same tabs, nothing to revive
        }
        // Both of these are sampled BEFORE the grace. VS Code's first revive routinely lands
        // *inside* it — it did in the field log, 1.5s into a 2.5s grace — and a baseline taken
        // afterwards would read that claim as the starting state rather than as progress,
        // leaving `lastClaim` unset and sending the wait to the long backstop: precisely the
        // eleven-second stall this quiet period exists to remove.
        let outstanding = this.outstandingRestores();
        // Adopted sessions belong to another machine's window, so no revive is coming for
        // them and there is nothing to wait on — a hand-off must not pay the deadline.
        const revivable = this.pendingRestores.some(entry => entry.revivable);
        await delay(grace);
        if (!revivable) {
            return;
        }
        const started = Date.now();
        let lastClaim: number | undefined;
        for (;;) {
            this.adoptRevivedTerminals();
            const remaining = this.outstandingRestores();
            if (remaining === 0) {
                return; // every queued slot is claimed or already on screen
            }
            if (remaining < outstanding) {
                outstanding = remaining;
                lastClaim = Date.now(); // a revive is running; re-arm the quiet window
            }
            if (lastClaim !== undefined) {
                if (Date.now() - lastClaim >= this.reviveQuietMs) {
                    this.log.trace(
                        `tmux terminals: revive went quiet for ${this.reviveQuietMs}ms with `
                        + `${remaining} session(s) unclaimed, opening them directly`
                    );
                    return;
                }
            } else if (Date.now() - started >= this.reviveDeadlineMs) {
                this.log.trace(
                    `tmux terminals: no revive after ${this.reviveDeadlineMs}ms, opening `
                    + `${remaining} queued session(s) directly`
                );
                return;
            }
            await delay(REVIVE_POLL_MS);
        }
    }

    /** Queued sessions that still have no terminal — the measure the revive wait watches.
     * Counts the queue minus anything already on screen, so a slot claimed by a profile
     * request and one observed in the window both register as progress. */
    private outstandingRestores(): number {
        return this.pendingRestores.filter(entry => !this.openSlots.has(entry.slot)).length;
    }

    private async plan(): Promise<void> {
        // A reconnect re-plans from scratch; entries left over from the previous pass would
        // hand out slots that have since been opened.
        this.pendingRestores.length = 0;
        this.adoptRevivedTerminals();
        const remote = await this.refreshRemote();
        const remoteBySlot = new Map(remote.map(s => [s.slot, s]));
        // Every slot with any evidence behind it: ours (mapped) or the remote's (a
        // session of this workspace we haven't mapped — the adoption candidates).
        const slots = [...new Set([...this.mapping.keys(), ...remoteBySlot.keys()])].sort((a, b) => a - b);

        this.log.trace(`tmux reconcile: ${slots.length} slot(s) to resolve, ${remote.length} session(s) on remote`);

        const counts = { restored: 0, reclaimed: 0, adopted: 0, pruned: 0, skipped: 0 };
        for (const slot of slots) {
            const state: SlotInput = {
                slot,
                mapped: this.mapping.has(slot),
                openHere: this.openSlots.has(slot),
                remote: remoteBySlot.get(slot),
            };
            // Log the observed inputs alongside the verdict — the line this replaced
            // ("slot N attached elsewhere") printed only a conclusion, which made a real
            // field bug indistinguishable from correct no-steal behaviour in user logs.
            this.log.trace(`tmux ${describeSlot(state)}`);
            const { action } = decideSlotAction(state);

            switch (action) {
                case 'restore':
                case 'restore-takeover': {
                    // `has-session` is a second, narrower probe than the list above: it
                    // catches a session that died between the two (or that list-sessions
                    // failed to report), so a dead mapping is pruned rather than spawning
                    // a terminal onto nothing.
                    const exists = await this.sessionExists(this.mapping.get(slot)!);
                    if (exists === undefined) {
                        // Unreachable, not absent. Keep the mapping (a later connect settles
                        // it) but queue nothing: `-A` on a session we could not confirm would
                        // quietly create an empty new one under that name.
                        counts.skipped++;
                    } else if (exists) {
                        // From our own mapping, so this client's VS Code may well have a
                        // persisted terminal for it — worth waiting on ({@link awaitRevive}).
                        this.pendingRestores.push({ slot, takeOver: action === 'restore-takeover', revivable: true });
                        if (action === 'restore-takeover') {
                            counts.reclaimed++;
                        } else {
                            counts.restored++;
                        }
                    } else {
                        this.mapping.delete(slot);
                        counts.pruned++;
                    }
                    break;
                }
                case 'adopt':
                    this.mapping.set(slot, remoteBySlot.get(slot)!.name);
                    // Another machine's session: nothing local ever persisted a terminal for
                    // it, so there is no revive to wait for (hand-off must stay immediate).
                    this.pendingRestores.push({ slot, takeOver: false, revivable: false });
                    counts.adopted++;
                    break;
                case 'skip':
                    counts.skipped++;
                    break;
            }
        }

        // Only the slots still awaiting a terminal stay reserved, so a brand-new terminal is
        // not pushed to a higher slot by a mapping entry that was just pruned.
        this.reservedSlots.clear();
        for (const entry of this.pendingRestores) {
            this.reservedSlots.add(entry.slot);
        }

        await this.persist();
        if (counts.restored || counts.reclaimed || counts.adopted || counts.pruned) {
            // Invisible UX: nothing louder than one line, even on adoption/reclaim. Worded as
            // a *plan*, because that is what it now is — these sessions are queued, and who
            // actually opens their terminal (VS Code's revive, or the drain) is decided over
            // the next couple of seconds and logged separately. The old wording claimed
            // "N re-attached" before anything had been attached at all.
            this.log.info(
                `tmux terminals: ${counts.restored} to re-attach, ${counts.reclaimed} to reclaim, `
                + `${counts.adopted} to adopt, ${counts.pruned} pruned`
            );
        }
    }

    /**
     * Open terminals for whatever VS Code's revive did not claim once the window closes.
     * This is the path for a machine with nothing to revive (a hand-off: PC closed, laptop
     * takes over), for a VS Code that persisted fewer terminals than there are sessions, and
     * for a reconnect — none of which produce revive calls.
     *
     * Re-checks the window first: a *reload* within the reconnection grace reconnects the
     * existing pty rather than relaunching it, so that terminal never calls the provider and
     * would otherwise still be sitting in the queue.
     */
    private drainPendingRestores(): void {
        this.adoptRevivedTerminals();
        const remaining = this.pendingRestores.splice(0);
        const opened = remaining.filter(entry => !this.openSlots.has(entry.slot));
        for (const entry of opened) {
            this.reopen(entry.slot, entry.takeOver);
        }
        if (opened.length) {
            this.log.trace(`tmux terminals: opened ${opened.length} session(s) VS Code did not restore`);
        }
        // `adoptRevivedTerminals` above can add mappings (a reload reconnected a pty that
        // plan() had not yet seen). Nothing else persists after the queue drains, so without
        // this those slots would be forgotten on the next window and their sessions stranded.
        this.persist().catch(err => this.log.trace(`tmux terminal: drain persist failed: ${errorText(err)}`));
    }

    /**
     * Claim the slots of terminals VS Code has already revived from its own persistence,
     * before reconcile decides anything. Without this, restore would re-attach a session
     * that is on screen already — two tmux clients on one session, mirroring keystrokes and
     * clamping the window to the smaller of the two.
     *
     * Only terminals whose `shellArgs` name one of *this* workspace's sessions count, so a
     * plain shell or another workspace's terminal never reserves a slot.
     */
    private adoptRevivedTerminals(): void {
        for (const terminal of this.listTerminals()) {
            const slot = this.slotFromCreationOptions(terminal.creationOptions);
            if (slot === undefined || this.openSlots.has(slot)) {
                continue;
            }
            this.terminalSlots.set(terminal, slot);
            this.openSlots.add(slot);
            this.mapping.set(slot, sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot));
            this.log.trace(`tmux terminal: slot ${slot} already revived by VS Code — leaving it alone`);
        }
    }

    /**
     * VS Code asks for a profile when a *new* terminal is created. Allocate the
     * lowest slot free both here and on the remote, record it, and return plain
     * terminal options; VS Code spawns the process (on the remote — Route A). The
     * token param is intentionally omitted (nothing to cancel in this cheap path).
     */
    async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
        // Wait for the restore *decision* so a brand-new terminal never races onto a slot it
        // is about to claim (duplicate mirrored tab). A failed restore must not block new
        // terminals, so its rejection is swallowed here.
        await this.initialized.catch(() => { /* restore failure never blocks a new terminal */ });

        // Restoring a session is a better answer than minting one whenever both are on the
        // table, and it is the ONLY correct answer when the caller is VS Code reviving a
        // persisted terminal — which is indistinguishable from a user pressing "New
        // Terminal", because the API hands the provider no context either way. Serving the
        // queue first makes both cases right: the revive gets its session back (with the
        // layout VS Code is restoring around it), and a user who really did want a new
        // terminal during those first seconds gets one of their own sessions back, which is
        // what they would have asked for next anyway.
        const pending = this.pendingRestores.shift();
        if (pending) {
            this.openSlots.add(pending.slot);
            this.reservedSlots.delete(pending.slot);
            const restored = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, pending.slot);
            this.mapping.set(pending.slot, restored);
            await this.persist();
            this.log.trace(`tmux terminal: slot ${pending.slot} claimed from the restore queue (${restored})`);
            return new vscode.TerminalProfile(this.buildOptions(pending.slot, pending.takeOver));
        }

        await this.refreshRemote(); // no-steal snapshot, refreshed on create
        // Claim the slot in the SAME synchronous step that chooses it. Recording the claim
        // after the probe below left an await between "0 is free" and "0 is mine", and VS
        // Code asks for several profiles at once when it revives several terminals — so two
        // calls both read 0 as free, both awaited, and both took it. Two terminals on one
        // tmux session: shared view, mirrored keystrokes.
        let slot = this.allocateSlot();
        this.openSlots.add(slot);
        // Shrink the no-steal TOCTOU: VS Code spawns the tmux process only *after*
        // this returns (a window we can't observe from here), so the snapshot above
        // can go stale — another client could attach our slot in between. Re-probe as
        // the last remote read before committing; if the chosen slot went free →
        // attached-elsewhere since, allocate again against the refreshed set
        // (`allocateSlot` skips `attachedRemoteSlots`). The two probes are kept
        // deliberately (don't collapse to one): the second is what makes the decision
        // reflect the freshest reachable state. This only narrows the race — the
        // return→spawn window is irreducible from here.
        await this.refreshRemote();
        if (this.attachedRemoteSlots.has(slot)) {
            this.log.trace(`tmux terminal: slot ${slot} taken since snapshot — reallocating`);
            this.openSlots.delete(slot);
            slot = this.allocateSlot();
            this.openSlots.add(slot);
        }
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        this.mapping.set(slot, name);
        await this.persist();
        this.log.trace(`tmux terminal: new slot ${slot} (${name})`);
        return new vscode.TerminalProfile(this.buildOptions(slot));
    }

    /**
     * A terminal for `slot` closed. Free the slot for reuse *in this window*; its
     * remote session is kept (detach, not kill). This is the low-level primitive used
     * by every close that is *not* the user closing the terminal — a window
     * shutdown/reload or the shell exiting — so a later reconnect re-attaches it.
     * The explicit-close path ({@link handleTerminalClosed}) kills instead.
     */
    releaseSlot(slot: number): void {
        this.openSlots.delete(slot);
        this.log.trace(`tmux terminal: slot ${slot} released (detached, session kept)`);
    }

    /**
     * Destroy `slot`'s remote session and forget it. Called only for a close VS Code
     * attributes to the user (see {@link handleTerminalClosed}) — closing a terminal has
     * to actually close it, or the session becomes an invisible leftover no reload will
     * ever surface again.
     *
     * Fire-and-forget because VS Code's close event handler is synchronous. A kill that
     * fails is logged and otherwise tolerated: the session then survives detached, and
     * since nothing suppresses it any more, the next reconcile simply re-attaches it —
     * a visible terminal the user can close again, never a hidden one.
     */
    private killSlotSession(slot: number): void {
        const name = this.mapping.get(slot);
        this.mapping.delete(slot);
        if (name) {
            this.log.trace(`tmux terminal: slot ${slot} closed by the user — killing ${name}`);
            // Hold the slot until the kill has actually landed. The close handler is
            // synchronous, so the kill is still travelling to the remote when it returns and
            // the slot is free again immediately — open a new terminal fast enough and its
            // `new-session -A` on the reused name races the `kill-session`. Losing that race
            // destroys the session of the terminal the user just opened. `finally` releases
            // the hold either way: a failed kill must not strand the slot for the life of
            // the window.
            this.killingSlots.add(slot);
            this.exec(buildKillSession(name))
                .catch(err => this.log.trace(`tmux terminal: kill of ${name} failed: ${errorText(err)}`))
                .finally(() => this.killingSlots.delete(slot));
        }
        this.persist().catch(err => this.log.trace(`tmux terminal: close persist failed: ${errorText(err)}`));
    }

    /** Live `vscode.Terminal` -> slot, so a later close can find and release the
     * right slot. VS Code gives the provider no handle to the `Terminal` it
     * eventually constructs from a returned `TerminalProfile` (nor from `reopen`'s
     * `openTerminal` call, which returns `void`) — this is populated instead from
     * `vscode.window.onDidOpenTerminal`, which fires for every terminal with the
     * `creationOptions` this provider gave it. */
    private readonly terminalSlots = new Map<vscode.Terminal, number>();

    /** Duplicate tabs this provider disposed itself ({@link handleTerminalOpened}). Their
     * close event must not be mistaken for the user closing a terminal — VS Code may well
     * report an extension-initiated dispose as `TerminalExitReason.User`, and that now kills
     * the session, which here is still in use by the tab we kept. */
    private readonly discardedDuplicates = new WeakSet<vscode.Terminal>();

    /**
     * Wire from `vscode.window.onDidOpenTerminal`. Records the slot (parsed back
     * out of the session name this provider baked into `shellArgs`) so the
     * matching `handleTerminalClosed` can free it. No-op for terminals that
     * aren't ours (no `shellArgs`, or a session name outside this workspace).
     */
    handleTerminalOpened(terminal: vscode.Terminal): void {
        const slot = this.slotFromCreationOptions(terminal.creationOptions);
        if (slot === undefined) {
            return;
        }
        // The other half of dropping `isTransient`: VS Code's revive and this provider's
        // reconcile can both restore the same slot, and neither can be made to win the race
        // (a remote terminal revives once the server connection is up, which is exactly when
        // reconcile runs). If reconcile got there first, discard the newcomer — two tmux
        // clients on one session mirror each other and clamp the window to the smaller size.
        if (this.terminalSlots.has(terminal)) {
            return; // already accounted for (adoptRevivedTerminals saw it)
        }
        for (const heldSlot of this.terminalSlots.values()) {
            if (heldSlot === slot) {
                // Logged at info, not trace: this only fires for a terminal that arrived
                // *without* going through `provideTerminalProfile` (which always allocates a
                // free slot, so a user's new terminal or split can never collide here). If it
                // ever fires for something else, the user's log has to say so out loud rather
                // than silently swallowing a tab they asked for.
                this.log.info(`tmux terminals: slot ${slot} is already on screen — discarding the duplicate tab`);
                // The close this triggers must not be read as the user closing a terminal,
                // which would kill a session that is very much still in use.
                this.discardedDuplicates.add(terminal);
                try {
                    terminal.dispose();
                } catch (err) {
                    // Disposing inside the open event is the awkward moment for it; a failure
                    // leaves a mirrored tab, which is survivable, so never let it escape into
                    // VS Code's event dispatch.
                    this.discardedDuplicates.delete(terminal);
                    this.log.trace(`tmux terminal: could not discard duplicate on slot ${slot}: ${errorText(err)}`);
                }
                return;
            }
        }
        this.terminalSlots.set(terminal, slot);
        this.openSlots.add(slot);
    }

    /**
     * Wire from `vscode.window.onDidCloseTerminal` — the fix for the real gap
     * `releaseSlot` alone left open: nothing was ever calling it. Without this,
     * closing and reopening a terminal in the same window session never freed a
     * slot, so every "New Terminal" after a close minted a brand-new, ever-growing
     * remote session instead of reattaching the one just detached.
     */
    handleTerminalClosed(terminal: vscode.Terminal): void {
        if (this.discardedDuplicates.has(terminal)) {
            // A tab this provider discarded as a duplicate. The slot is still held by the
            // terminal we kept, so releasing or killing anything here would be wrong.
            this.discardedDuplicates.delete(terminal);
            return;
        }
        const slot = this.terminalSlots.get(terminal);
        if (slot === undefined) {
            return;
        }
        this.terminalSlots.delete(terminal);
        this.releaseSlot(slot);
        // Only an *explicit user close* may kill. `onDidCloseTerminal` fires on disposal
        // for four distinct reasons (`TerminalExitReason`, upstream VS Code 1.71+): Shutdown=1
        // "the window closed/reloaded", Process=2 "the shell process exited", User=3,
        // Unknown=0. Everything except User must leave the session running — killing on
        // Shutdown would destroy a long Claude Code run every time the window closes,
        // which is the precise opposite of what this fork is for.
        if (isUserClose(terminal)) {
            this.killSlotSession(slot);
        } else {
            this.log.trace(`tmux terminal: slot ${slot} closed by ${closeReason(terminal)} — session kept`);
        }
    }

    /** The slot encoded in `options.shellArgs`' `-s <name>` (our `buildAttachOrCreateArgv`
     * shape), resolved via `sessionSlot` so it also filters out anything that isn't
     * one of this workspace's own sessions. `undefined` for anything else. */
    private slotFromCreationOptions(options: vscode.Terminal['creationOptions']): number | undefined {
        if (!options || !('shellArgs' in options) || !Array.isArray(options.shellArgs)) {
            return undefined;
        }
        const flagIndex = options.shellArgs.indexOf('-s');
        const name = flagIndex >= 0 ? options.shellArgs[flagIndex + 1] : undefined;
        return typeof name === 'string' ? sessionSlot(name, this.ctx.hostKey, this.ctx.workspaceKey) : undefined;
    }

    /** Slots this client currently maps — observability for wiring and tests. */
    mappedSlots(): number[] {
        return [...this.mapping.keys()].sort((a, b) => a - b);
    }

    /** Lowest slot not open in this window, not attached elsewhere on the remote, and
     * not reserved for connect-time restore/adoption (the init-race guard). */
    private allocateSlot(): number {
        let slot = 0;
        while (
            this.openSlots.has(slot)
            || this.attachedRemoteSlots.has(slot)
            || this.reservedSlots.has(slot)
            || this.killingSlots.has(slot)
        ) {
            slot++;
        }
        return slot;
    }

    /** Open (or re-attach — `-A` is idempotent) a terminal for `slot`. Idempotent
     * across reconnects: a re-resolve re-runs {@link reconcile} over the same mapping,
     * so a slot already backing an open terminal in this window is skipped rather than
     * spawning a second, mirrored tab. Only genuinely-not-open survivors/orphans open. */
    private reopen(slot: number, takeOver = false): void {
        if (this.openSlots.has(slot)) {
            return;
        }
        this.openSlots.add(slot);
        try {
            this.openTerminal(this.buildOptions(slot, takeOver));
        } catch (err) {
            // `createTerminal` is documented to throw ("@throws When running in an
            // environment where a new process cannot be started") and
            // this runs inside reconcile's loop. Letting it propagate would abandon every
            // remaining survivor AND skip the `persist()` that follows the loop, silently
            // discarding an already-mutated in-memory mapping (adoptions recorded, entries
            // pruned) — losing bookkeeping for sessions that are still alive on the remote.
            // Drop the slot back so a later open can retry it, and keep reconciling.
            this.openSlots.delete(slot);
            this.log.trace(`tmux terminal: slot ${slot} failed to open: ${errorText(err)}`);
        }
    }

    private buildOptions(slot: number, takeOver = false): vscode.TerminalOptions {
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        return {
            // Invisible UX: title the tab after the workspace folder, never "tmux".
            name: folderName(this.ctx.cwd),
            // Absolute path from the probe (or a bare `tmux` fallback) — see tmuxPath.
            shellPath: this.tmuxPath,
            shellArgs: buildAttachOrCreateArgv(name, this.ctx.cwd, undefined, { historyLimit: this.historyLimit, takeOver }),
            cwd: this.ctx.cwd,
            // Deliberately NOT `isTransient: true`. That opted the terminal out of VS Code's
            // own persistence, on the reasoning that tmux owns lifetime so VS Code should
            // keep its hands off. It owns the *session*, but not the *window*: the same
            // persistence layer is what restores split and group layout, so opting out threw
            // away every split the user had made and returned their terminals as flat tabs.
            // Letting VS Code revive them is harmless — it relaunches this same
            // `new-session -A` argv, which re-attaches the session it left — and the
            // duplicate-restore race that creates is handled in `handleTerminalOpened`.
        };
    }

    /** Snapshot this workspace's sessions on the remote; also refresh the
     * attached-elsewhere guard. Degrades to "no sessions" if the probe fails —
     * never breaks the connect. */
    private async refreshRemote(): Promise<RemoteSession[]> {
        let result: { stdout: string; stderr: string };
        try {
            result = await this.exec(buildListSessions());
        } catch (err) {
            // Retain the last-known `attachedRemoteSlots` on a *transient* probe
            // failure (network blip): clearing it would silently disarm the no-steal
            // guard, and the next new terminal could -A-attach a slot another client
            // holds (mirrored keystrokes). Erring safe keeps a since-detached slot
            // guarded only until the next *successful* probe re-syncs it — worst case
            // a higher slot number, never a steal. The empty return still means "saw no
            // sessions this round" so restore/adoption don't act on data we don't have.
            this.log.trace(`tmux list-sessions failed: ${errorText(err)}`);
            return [];
        }
        const sessions: RemoteSession[] = [];
        const attached = new Set<number>();
        for (const parsed of parseListSessions(result.stdout)) {
            const slot = sessionSlot(parsed.name, this.ctx.hostKey, this.ctx.workspaceKey);
            if (slot === undefined) {
                continue; // another workspace/user's session — not ours to touch
            }
            sessions.push({ slot, name: parsed.name, attached: parsed.attached, windows: parsed.windows });
            if (parsed.attached) {
                attached.add(slot);
            }
        }
        this.attachedRemoteSlots = attached;
        return sessions;
    }

    /**
     * Whether a named session still exists (`has-session`), read from stderr since `exec`
     * surfaces no exit code. `undefined` means the question could not be *asked* — the
     * command never reached the remote — which is not the same as "no".
     *
     * That distinction is the whole point. `refreshRemote` already refuses to read an empty
     * `list-sessions` as proof of absence, because the probe degrades to "no sessions" when
     * the channel fails. This probe used to answer "gone" on a rejection, so the very blip
     * that guard was written to survive still pruned the mapping one slot at a time — and
     * the mapping is client-local, the only record of which session belongs to which slot.
     */
    private async sessionExists(name: string): Promise<boolean | undefined> {
        try {
            const { stderr } = await this.exec(buildHasSession(name));
            return !MISSING_SESSION_RE.test(stderr);
        } catch (err) {
            this.log.trace(`tmux has-session probe failed for ${name}: ${errorText(err)}`);
            return undefined;
        }
    }

    /**
     * Persist the slot mapping, serialised against every other persist.
     *
     * Each call writes the WHOLE derived record, so two overlapping writes can land out of
     * order and leave workspaceState holding the older snapshot — and that record is the only
     * thing telling the next window which session belongs to which slot. Chaining costs
     * nothing (these are tiny Memento writes) and makes last-call-wins actually true.
     */
    private persist(): Promise<void> {
        this.persistChain = this.persistChain.then(
            () => this.writeState(),
            () => this.writeState(),
        );
        return this.persistChain;
    }

    private async writeState(): Promise<void> {
        const record: Record<string, string> = {};
        for (const [slot, name] of this.mapping) {
            record[String(slot)] = name;
        }
        await this.state.update(SLOT_MAPPING_STATE_KEY, record);
        // Shed 1.0.5's tombstone list rather than leaving it to rot in workspaceState.
        await this.state.update(LEGACY_TOMBSTONE_STATE_KEY, undefined);
    }
}

/** Load the persisted `slot → sessionName` mapping, ignoring malformed entries. */
function readMapping(state: vscode.Memento): Map<number, string> {
    const raw = state.get<Record<string, string>>(SLOT_MAPPING_STATE_KEY) ?? {};
    const mapping = new Map<number, string>();
    for (const [key, value] of Object.entries(raw)) {
        const slot = Number(key);
        if (Number.isInteger(slot) && slot >= 0 && typeof value === 'string') {
            mapping.set(slot, value);
        }
    }
    return mapping;
}

/** Last path segment of a POSIX path (remote paths are Unix — tmux is Unix-only).
 * Used as the invisible tab title; falls back to the whole path for edge inputs. */
function folderName(remotePath: string): string {
    const trimmed = remotePath.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    return base || remotePath;
}

/** Best-effort message from an unknown thrown value (for trace logs only). */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** `setTimeout` as a promise. A zero delay still yields a tick, which the revive wait
 * relies on: the queue must be observable by a `provideTerminalProfile` that has not run
 * yet. */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** `TerminalExitStatus` as it looks from VS Code 1.71, which added `reason` +
 * `TerminalExitReason`. The pinned 1.70.2 typings (`update:dts` in package.json) predate
 * the property — the declared shape has only `code` — so {@link exitReason} reads it
 * through this structural view: an intersection with the real type, not a redefinition.
 * At runtime a 1.70 host simply lacks the property and it reads as `undefined`, which is
 * exactly how the callers below must (and do) treat it. */
type TerminalExitStatusWithReason = vscode.TerminalExitStatus & {
    /** Upstream numeric `TerminalExitReason`: Unknown=0, Shutdown=1, Process=2, User=3. */
    readonly reason?: number;
};

/** `TerminalExitReason.User` (upstream 1.71+: "The user closed the terminal"). Written as
 * a literal rather than referencing `vscode.TerminalExitReason.User`: the enum only exists
 * from VS Code 1.71 and this extension declares `engines.vscode: ^1.70.2`, so on a 1.70 host
 * the enum object is undefined and dereferencing it would throw inside an event handler. */
const EXIT_REASON_USER = 3;

/** The terminal's exit reason as a plain number — upstream `TerminalExitReason`
 * (Unknown=0, Shutdown=1, Process=2, User=3) — when the host reports one. `undefined`
 * when it does not: `exitStatus.reason` only exists from VS Code 1.71 and the pinned
 * 1.70.2 typings predate it (the declared `TerminalExitStatus` has only `code`), so the
 * property is reached through {@link TerminalExitStatusWithReason}. */
function exitReason(terminal: vscode.Terminal): number | undefined {
    return (terminal.exitStatus as TerminalExitStatusWithReason | undefined)?.reason;
}

/** Whether a closed terminal was closed *by the user*, as opposed to a window
 * reload/shutdown or the shell process exiting — the one case that kills the session.
 *
 * `exitStatus.reason` is absent on hosts older than 1.71 (`engines.vscode` is ^1.70.2), and
 * there the reason is simply unknowable. The two possible mistakes are not symmetric:
 * wrongly keeping a session costs one stale terminal that the next reconcile re-attaches,
 * wrongly killing one destroys work that cannot be recovered. So an absent reason means
 * "not a user close". */
function isUserClose(terminal: vscode.Terminal): boolean {
    return exitReason(terminal) === EXIT_REASON_USER;
}

/** Human-readable close reason for the trace log. */
function closeReason(terminal: vscode.Terminal): string {
    switch (exitReason(terminal)) {
        case 1: return 'window shutdown/reload';
        case 2: return 'shell process exit';
        default: return 'unknown';
    }
}
