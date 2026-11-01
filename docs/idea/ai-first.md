# AI-first repo

This repo is built to be worked by **AI coding agents** — agents write ~100% of
the code, humans review/steer/operate. The full playbook lives in
[`../../../gold-standards-in-ai/`](../../../gold-standards-in-ai/docs/00-philosophy.md);
this doc records what that means *here*, and what's already true vs. still a gap.

> The core loop: **great DX → fast agents → more shipped → better DX.** Every
> friction an agent hits (a hidden command, an undocumented convention, a slow
> gate) taxes *every turn*. Remove it once in the repo, not in each prompt.

## The setup an agent inherits

A fresh agent should be able to, with zero hand-holding:

1. Read [`CLAUDE.md`](../../CLAUDE.md) → stack, the SRP module map, exact commands.
2. Read [`docs/idea/`](README.md) → *why* this exists and the persistence goal.
3. Run `/plan` then `/feature` (`.claude/commands/`) → plan a slice, build it,
   verify, PR.
4. Find any symbol via CodeGraph or the predictable `src/` layout.
5. Make a change, run the gate, know it's green.

If any step needs tribal knowledge, that's a DX bug — fix it in the repo.

## House rules (inherited, non-negotiable)

- **SOLID / SRP.** One file, one job; files ≤ ~500 LOC. The tmux integration is
  its own module, never bolted onto the SSH classes. (See `CLAUDE.md`.)
- **Unit TDD — no test, no merge.** Write the failing unit test *first*, then the
  code that passes it. Pure logic (session naming, attach-or-create, reap
  decisions, config parsing) is designed test-first; the test is the spec. The
  agent's biggest edge is verifying its own work. The runner (vitest, `npm test`)
  is wired up and this is how every tmux module in `src/tmux/*` got built — see
  below for what's still outstanding.
- **Type-safe, low undefined behaviour.** TS `strict`, no `any`; narrow `unknown`.
  Fail fast and loud — never swallow an error on the security-sensitive paths.
- **Surgical diffs.** Every changed line traces to the task. Don't reformat
  upstream files — it poisons the fork merge.
- **Write it down for the next session.** Agents are stateless; `CLAUDE.md` +
  `docs/idea/` are the memory. Compress (read every turn), date load-bearing
  claims, delete what rots.

## Current state vs. target

| Capability | Now | Target |
|------------|-----|--------|
| `CLAUDE.md` project brain | ✅ | keep ≤ 600 lines, current |
| `docs/idea/` vision | ✅ | this set |
| `/feature`, `/planx` commands | ✅ (`.claude/commands/`) | + `/verify` skill |
| **Test suite** | ✅ vitest, `npm test` — 140+ tests over the pure modules | keep pace with new pure logic; add integration coverage once the session-manager tree view (see [`roadmap.md`](roadmap.md)) lands |
| **tmux integration, test-first** | ✅ session naming, attach-or-create, reap decisions, bootstrap probe, multi-client provider — all unit-tested before/alongside implementation (`test/tmux/*`) | — |
| **`bin/` DX scripts** | ✅ `bin/setup` = `npm install`, `bin/dev` = `npm run watch:src`, `bin/check` = `npm run compile:src && npm run lint && npm test` | — |
| **Hooks + permissions** | ❌ | broad allow + pre-commit lint/typecheck hook, so unlinted code physically can't land |
| **CodeGraph index** | ❌ no `.codegraph/` | index `src/` for structural lookups |
| **CI green gate** | partial | typecheck + lint + bundle + tests < 5 min |
| **Marketplace publish** | manual (`vsce`) | scripted release of the `.vsix` |
| **Empirical F5/EDH persistence proof** | ⚠️ partial — see below | run the [`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md) / [`102/08-verify.md`](../plans/2026/07/24/102-bug-audit-fixes/08-verify.md) matrix on a real Unix remote via a live VS Code window |

### Empirical F5/EDH proof — current status (2026-07-24, `102-bug-audit-fixes` slice 08)

This agent environment still has **no VS Code desktop binary/display** (only a
headless `vscodium-server`, confirmed via `ps aux` — no `code`/`codium` desktop
process, no `@vscode/test-electron` wired up) — the same limitation this table
already flagged. A real F5/Extension-Development-Host session (live VS Code
window, real SSH remote, real terminal UI) **still cannot be run from here**;
that part of the gap is honestly still open, not discharged.

What *was* newly closed this session: rather than settle for unit tests against
a faked `exec`, the gates were run for real (`npm test` 377/377, `compile:src`,
`lint`, `bundle`, `package`, `bash -n server-setup.sh` — all clean) **and** the
compiled `src/tmux/tmuxSession.ts` builders were driven against a **real, local
tmux 3.4 server** (isolated `-L` socket, no VS Code involved) to get genuine
tmux-protocol evidence for the rows a live attach would exercise:

- Attach-or-create against a real server: session created, named correctly,
  survives a second `-A` call (no duplicate).
- **Found and fixed a real bug this way**: `set-option -t =<name> status off`
  and `... history-limit N` — the two `set-option` calls in
  `buildAttachOrCreateArgv` — silently failed against real tmux (`-t` for
  `set-option` is target-*window* syntax; a bare `=<name>` isn't resolved as
  "exact-match session, default window" the way it is for `has-session`/
  `kill-session`/`set-window-option`). Effect: the tmux status bar stayed
  **visible** (a hard Invisible-UX violation) and `historyLimit` silently never
  applied — both invisible to the existing unit tests because they fake `exec`
  and never touch real tmux. Fixed by using `=<name>:` (trailing colon) for
  those two targets; TDD red→green; re-verified against real tmux post-fix
  (`status off`, `history-limit 1000`, `remain-on-exit off` all confirmed
  applied on a real session, including via one real interactive `-A` pty
  attach running the exact unmodified production argv chain end-to-end).
- Real `#{pane_dead}` corpse detection: `shouldReap` correctly flags a real
  dead-pane session.
- Real `#{session_attached}` flip 0→1 on an actual client attach (the no-mirror
  guard's underlying signal).
- Exact-match `-t =<name>` on `has-session`/`kill-session` verified against a
  deliberately colliding neighbour session name (the historical prefix-match
  footgun) — does not misfire.
- `command -v tmux`-resolved absolute path spawns correctly (non-login-PATH
  installs).

This is real signal a mocked-`exec` unit suite structurally cannot produce, and
it found a real, previously-shipped bug. It does **not** substitute for rows
that are inherently about VS Code's own UI (consent dialogs, the "Persistent
Shell" profile picker, palette command registration, tree-view rendering,
Windows remotes) — those remain unverified pending a real Extension
Development Host session, per the "Next steps" item below. See
[`102-bug-audit-fixes/status.yml`](../plans/2026/07/24/102-bug-audit-fixes/status.yml)
for the full per-row breakdown.

## Next steps to close the gaps

In rough priority (each a `/planx` candidate):

1. **Hooks + permissions** — `.claude/settings.json` with a
   pre-commit gate.
2. **CodeGraph index** — `codegraph init` so agents do structural lookups.
3. **The empirical verification gate (still open)** — run
   [`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md) /
   [`102/08-verify.md`](../plans/2026/07/24/102-bug-audit-fixes/08-verify.md) on
   a real Unix remote via a live Extension Development Host window: the one
   part of the gap real-tmux scripting (see above) cannot close — VS Code's own
   UI (dialogs, profile picker, palette, tree view) needs an actual VS Code
   process with a display, which this agent environment does not have. Requires
   a human (or an environment with a VS Code desktop binary + display) to run
   F5 and walk the matrix.
4. **Deferred features** — session-manager tree view, Claude Code first-class
   attach, mosh-over-tmux — see [`roadmap.md`](roadmap.md) for why each waits.

Reference the gold-standards docs when doing any of these — don't reinvent the
conventions.
