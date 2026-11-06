# Brief: is the project healthy?

Daily checkup fired by `schedules: health`: the failures no issue or PR announces.

## Signals

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci-main.yml --branch main --event push --limit 1 --json conclusion,headSha,url`, then `git rev-parse origin/main` | `success` on the `origin/main` tip; a null conclusion or another sha is no verdict |
| Dependabot is not stuck | `gh pr list --app dependabot --state open --limit 100 --json number,updatedAt,statusCheckRollup` | no PR with failed checks and more than 7 days since `updatedAt` |

A null run is not always a red: both workflows ignore markdown-only diffs
(`.github/workflows/ci-pr.yml:7-8`, `.github/workflows/ci-main.yml:7-8`), so a
docs-only push to `main` starts no run at all. Confirm what the tip touched before
reading a missing run as a failure.

## What to file

For each unhealthy signal, one ask, unless an open issue already carries its exact title
(`gh issue list --state open --search "<title> in:title" --json number,title`, then compare byte for byte).
Titles are stable: nothing that changes run to run (sha, run URL) goes in one; that goes in the body,
with the command and its output. Unreadable evidence is no verdict: re-run it, never file it as a defect.
A red `main` comes first.

## Checks that exist on main

Declared rows, not an enforced gate: nothing parses this file — the schedule hands it to
an agent (`.dz/maintainer/maintainer.yml:58`, `.dz/README.md:8`). One row per check that
exists here; each cell after the first names what it runs and the `path:line` that proves it.

| Check | What it runs | Where it lives |
|---|---|---|
| CI `check`, on a pull request to `main` | `npm ci` → `npm run build` → `npm test` → `npm run lint:all` → commitlint over the PR range | `.github/workflows/ci-pr.yml:13` — steps at `:34`, `:38`, `:42`, `:46`, `:54-70` |
| CI `check`, on a push to `main` | the same five steps, lockstep with `ci-pr.yml` | `.github/workflows/ci-main.yml:13` — steps at `:34`, `:38`, `:42`, `:46`, `:58-79` |
| `bin/check` | `npm run compile:src && npm run lint && npm test` — the local gate; the pre-commit hook runs the same minus `eslint` (`.husky/pre-commit:4`), so a green hook is weaker than this | `bin/check:4` |
| `bin/setup` | `npm install` — dependencies, then the manifest's own hooks: `postinstall` patches `ssh2` and fetches the VS Code dts, and `prepare` runs `husky` **and `lint:package`**, the masked `fixpack` gap below | `bin/setup:4`, `package.json:32-33` |
| `bin/dev` | `npm run watch:src` — `tsc-watch` plus a dev bundle | `bin/dev:4`, `package.json:42` |
| `npm run compile:src` | `tsc -b` into `out/` — the typecheck | `package.json:26` |
| `npm run lint` | `eslint` | `package.json:27` |
| `npm run lint:all` | `lint:package`, `npm audit`, `ci:lint`, `lint` — what CI's lint step calls; its first member cannot fail (gap below), so this row is not a manifest verdict | `package.json:28` |
| `npm test` | `vitest run` | `package.json:35` |
| `npm run build` | `clean` → `compile:src` → `bundle` (webpack production) | `package.json:20`, `package.json:21` |
| `npm run ci:lint` | `pipx run zizmor .` over the workflows | `package.json:23` |
| pre-commit hook | `npx lint-staged` — `fixpack` **rewriting** a staged `package.json` (gap below: the same masked manifest step), `zizmor` over staged workflows, `eslint` over staged `*.ts` — then `npm run compile:src && npm test` | `.husky/pre-commit:3-4`; staged set `.lintstagedrc.yml:1-2` (`fixpack`), `:3` (`zizmor`), `:4` (`eslint`) |
| commit-msg hook | `npx commitlint --edit "$1"` | `.husky/commit-msg:3` |
| F5/EDH matrix | **manual, one-off**: 21 rows on a real Unix remote; last run 19/21 PASS | `docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md:16-38`, results `results-2026-07-24.md:95` |

`check` is the required merge check (`.dz/maintainer/maintainer.yml:34-35`).

## Gaps — claims that cannot fail or cannot run

| Gap | Why it is not a green row |
|---|---|
| `npm run lint:package` | `fixpack \|\| true` (`package.json:30`) exits 0 whatever fixpack does, and rewrites `package.json` — masked wherever it runs: inside `lint:all` (`package.json:28`), from `prepare` on every `npm install` (`package.json:33`, so `bin/setup` too), and as lint-staged's `fixpack` on a staged `package.json` (`.lintstagedrc.yml:1-2`). The package-manifest part of lint is unknown, not healthy |
| the F5/EDH matrix | cannot run in an agent environment — no VS Code desktop binary or display (`docs/idea/ai-first.md:62-67`) — and its last run left rows open: row 13, no real Windows remote (`results-2026-07-24.md:85`), row 18, Claude Code TUI (`results-2026-07-24.md:90`) |
| `bin/check` under CI | no workflow invokes it (repo-wide grep): CI runs `npm run build`, `npm test` and `npm run lint:all` as separate steps (`.github/workflows/ci-pr.yml:38`, `:42`, `:46`), so `bin/check` green is a local/pre-commit signal only |
| a missing `check` run | `paths-ignore: **/*.md` (`.github/workflows/ci-pr.yml:7-8`, `.github/workflows/ci-main.yml:7-8`) means a markdown-only diff never starts the job: a skipped check, never a pass — do not file it and do not weaken the workflow |
