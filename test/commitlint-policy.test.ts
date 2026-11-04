import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

// Drive the DECLARED @commitlint/cli binary (package.json:54) instead of
// importing @commitlint/load and @commitlint/lint: neither of those is a
// declared dependency - they resolve only because npm hoists them out of
// @commitlint/cli's tree, so a dependency bump or a lockfile refresh would
// break this test on an unresolvable import.
const repoRequire = createRequire(path.join(root, 'package.json'));
const commitlintCli = path.join(
    path.dirname(repoRequire.resolve('@commitlint/cli/package.json')),
    'cli.js',
);

// The verbatim message of commit 1b20fbe9f4244501b114bd13c372f04a9e4df980 - the
// squash-merge of PR #35 that pushed main and failed the 'Lint commit' step of
// CI run 41298636684 with exit code 1:
//
//   x   subject may not be empty [subject-empty]
//   x   type may not be empty [type-empty]
//   !   footer must have leading blank line [footer-leading-blank]
//
// Its subject is the PR title plus "(#35)": a squash-merged pull request
// carries no Conventional-Commits type, and that shape must pass the policy.
const PR_TITLE_MERGE_MESSAGE = `Ensure staged TypeScript and workflow checks run reliably (#35)

## What

npm audit checks the whole dependency tree, not the staged
package.json, so keeping it in .lintstagedrc.yml refused every commit
on pre-existing dev-dependency advisories regardless of staged
content. It stays enforced by npm run lint:all (CI runs it on every
push and PR) and npm run audit:fix; fixpack, ESLint and pipx run
zizmor keep failing the hook on their own findings. The '"*.ts":
eslint' glob is unchanged: installed lint-staged 16.4.0 matches
nested paths via matchBase.

## Acceptance

- .lintstagedrc.yml is exactly 4 lines: ./package.json: [fixpack],
.github/workflows/*.yml: pipx run zizmor, "*.ts": eslint — npm audit
gone, the "*.ts" pattern byte-unchanged
- test/lint-staged.test.ts:109 pins the ./package.json task commands to
exactly ['fixpack'], and the matcher test still proves root.ts and
src/tmux/nested.ts reach ESLint while unrelated files do not
- npm test -- test/lint-staged.test.ts --maxWorkers=2 exits 0 — 8 passed
+ 1 skip with logged reason on a pipx-less box (9 passed where
pipx/python3/PyPI exist)
- Lint violations still fail the hook: ESLint no-explicit-any exit 1
propagates through the task runner, pipx stub exit 17 fails the workflow
task, missing pipx fails loudly (Task failed to spawn), and the sh -e
hook stops before compile/test on checker failure
- README.md records the relocation (audit enforced via lint:all, CI,
audit:fix — not skipped) and retains the matching + hook verification
evidence paragraphs
- package.json is byte-unchanged: pipx ci:lint/ci:lint:fix scripts at
lines 23-24, lint:all retaining npm audit at line 28, audit:fix at line
19

## Changes

- \`.lintstagedrc.yml\` (edit) — Delete line 3 (' - npm audit') so the
staged package.json task is fixpack only; keep the other three lines
byte-identical. This unblocks the harness commit: tree-scoped npm audit
(38 pre-existing dev-dep advisories no staged change can fix) refused
every commit in prior runs after a green gate, while audit stays
enforced via package.json:28 lint:all (CI runs it on every push/PR) and
package.json:19 audit:fix.
- \`test/lint-staged.test.ts\` (edit) — Line 109 only: change the
assertion to toEqual(['fixpack']) (was ['fixpack', 'npm audit']). Every
other line is frozen byte-for-byte — the matcher test (root + nested TS
reach ESLint, unrelated files don't), real-ESLint run, stubbed pipx
propagation, gated real-zizmor acquisition, no-pipx loud failure and sh
-e hook tests are the recorded evidence and must not drift.
- \`README.md\` (edit) — Rewrite exactly two passages to the sentences
pinned in sharedContext: the 'What the hook checks' opener (current
lines 105-107) and the tail of the Harness-only-evidence paragraph
(current lines 183-185), recording that the hook runs
fixpack/ESLint/pipx-zizmor and that npm audit is tree-scoped, relocated,
and still enforced via lint:all + CI + audit:fix. Leave every other line
untouched, including the measured evidence at lines 120-177.
- \`package.json\` (edit) — Verify-only, expect zero byte change: confirm
line 19 audit:fix, lines 23-24 pipx run zizmor scripts, line 28 lint:all
retaining npm audit — the enforced homes the rewritten README claims
rely on. Change nothing; if confirmed intact, report this path as
needing no change.

## Verification

\`./bin/check\` passed (exit 0) in 21s.

## Notes

Premises of the request the team disproved:

- The task's command listing shows ci:lint as 'zizmor .' (no pipx); the
actual tree holds 'pipx run zizmor .' at package.json:23-24 — the
listing was read from a pre-diff state and the resumed diff IS fully
applied (also .lintstagedrc.yml:1-5 and test/lint-staged.test.ts match
the prior runs' described end state).
- The prior attempt's README.md:183-185 asserts an npm audit failure
must block the staged package check; enforced literally that makes the
change uncommittable forever — runs #1/#2 were refused at exactly this
hook (npm audit exit 1, 38 pre-existing dev-dependency advisories) after
a green gate. The check is tree-scoped, not staged-file-scoped; its
enforcement home is lint:all (package.js [trimmed]
- The report's root-only premise for the TypeScript glob is false:
node_modules/lint-staged/lib/matchFiles.js:16 enables matchBase for
slash-free patterns, so '"*.ts": eslint' already matches nested files —
the pattern stays unchanged and the test proves it against installed
lint-staged 16.4.0.

Follow-up work this change creates outside its diff:

- \`package-lock.json\` — Relocating npm audit out of .lintstagedrc.yml
leaves CI's lint:all step (ci-pr.yml:46, ci-main.yml:46) as the sole
automated enforcement of the pre-existing 38 dev-dependency advisories
(release-it/undici chain, vite); A dedicated dependency task must run
npm run audit:fix / adjust pins (the release-it remediation is a
breaking downgrade per the audit report); until then every PR's CI fails
at the lint:all step exactly as it already does today for any PR — not
caused by this change, but made load-bearing by it

<!-- dz-task:tsk_d3e146084aebcde88545a0a6ef3f8c73 -->

---

🤖 Opened by **developerz.ai** for task
\`tsk_d3e146084aebcde88545a0a6ef3f8c73\` on
developerz-ai/open-remote-ssh-tmux.

Raised automatically by the \`raw_task_triage\` lane.

<!-- dz-stack:start -->
> 🤖 developerz.ai, an automated agent, not a human — this PR is one
slice of a stacked plan.
> Dispatched automatically by the \`raw_task_triage\` lane
> Model \`glm-5.3-flash\` on \`api.z.ai\` via \`native\`, funded by
\`account_key\`
> Ran on box \`hv-dedicated-ci-0\`
> Cost ~$0.10 for 767.2k in / 81.7k out (estimate: list price x reported
tokens, cached input at its cached rate)
> Run timeline
[\`run_437caece17bd41fe914c5980bcf72334\`](https://app.developerz.ai/fleet/runs/run_437caece17bd41fe914c5980bcf72334)
> Part 1/1 of plan
[\`rtk_e7c1d463c5e34a97820724d3df0f9c61\`](https://app.developerz.ai/fleet/plans/rtk_e7c1d463c5e34a97820724d3df0f9c61)
<!-- dz-stack:end -->

Co-authored-by: developerz-ai[bot] <286432749+developerz-ai[bot]@users.noreply.github.com>`;

// The message the platform's follow-up lane writes when it lands this round's
// changes on a pull request branch:
//
//   chore(babysit): land commitlint.config.js (+1 more)
//
// The type is machine-chosen — the lane reads no setting from this repository —
// so the repository's policy has to say what that type may be: `chore` is one of
// the ALLOWED types (`build`, `chore`, `ci`, …) like every other commit. The
// config waives no rule for machine-written subjects — the type policy and the
// body-length limit apply to them too.
const AUTOMATED_LAND_MESSAGE = `chore(babysit): land commitlint.config.js (+1 more)

Follow-up intent: Address review findings on developerz-ai/open-remote-ssh-tmux#43

Dz-Task-Id: tsk_582df6d71f80ef4ff6fc04293f28839f`;

// The same land commit written with a type outside the allowed list. It has to
// be rejected: the land shape gets no waiver, so its type is judged by
// `type-enum` exactly like a hand-written commit's.
const AUTOMATED_LAND_MESSAGE_WITH_DISALLOWED_TYPE = `wip(babysit): land commitlint.config.js (+1 more)

Follow-up intent: Address review findings on developerz-ai/open-remote-ssh-tmux#43

Dz-Task-Id: tsk_582df6d71f80ef4ff6fc04293f28839f`;

// The same land commit with one body line over the limit. No rule is waived for
// the land shape, so the body-length limit applies to it as well.
const AUTOMATED_LAND_MESSAGE_WITH_OVERLONG_BODY = `chore(babysit): land commitlint.config.js (+1 more)

${'x'.repeat(201)}`;

// The land commit with an empty subject. The type policy does not exempt the
// land shape from the subject rules either.
const AUTOMATED_LAND_MESSAGE_WITH_EMPTY_SUBJECT = `chore(babysit): 
`;

// The repo's real policy, applied the way the 'Lint commit' step applies it:
// the declared @commitlint/cli binary reads the message from stdin and
// resolves commitlint.config.js from the repo root. Exit code 0 = accepted,
// 1 = rejected; the report on stdout names the rule that rejected it
// ("[type-enum]").
interface Verdict {
    status: number;
    stdout: string;
}

function verdict(message: string): Promise<Verdict> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [commitlintCli, '--no-color'], { cwd: root });
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
            reject(new Error('commitlint stdin/stdout/stderr pipes are unavailable'));
            return;
        }
        let out = '';
        let err = '';
        stdout.setEncoding('utf8');
        stderr.setEncoding('utf8');
        stdout.on('data', (chunk: string) => { out += chunk; });
        stderr.on('data', (chunk: string) => { err += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            const status = code ?? 0;
            if (status !== 0 && status !== 1) {
                reject(new Error(`commitlint exited with ${status}: ${err}`));
                return;
            }
            resolve({ status, stdout: out });
        });
        stdin.end(message);
    });
}

describe('commit-message policy', () => {
    it('accepts the squash-merge message that failed the Lint commit step of run 41298636684', async () => {
        const result = await verdict(PR_TITLE_MERGE_MESSAGE + '\n');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
    }, 30_000);

    it('still rejects a commit whose type is outside the allowed list', async () => {
        const result = await verdict('wip: drop the notes file\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[type-enum]');
    }, 30_000);

    it('still rejects a disallowed type when the subject ends in a PR reference', async () => {
        const result = await verdict('wip: bump dependencies (#36)\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[type-enum]');
    }, 30_000);

    it('still rejects an untyped subject without a PR reference', async () => {
        const result = await verdict('Ensure staged checks run reliably\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[type-empty]');
        expect(result.stdout).toContain('[subject-empty]');
    }, 30_000);

    it('keeps the release-shaped exemptions', async () => {
        expect((await verdict('v1.2.0\n')).status).toBe(0);
        expect((await verdict('chore: version 1.2.0\n')).status).toBe(0);
    }, 30_000);

    // The land commit the platform's follow-up lane actually writes. `chore` is
    // an allowed type, so the message is accepted — and judged by every rule,
    // like a hand-written commit.
    it('accepts the automated land commit the follow-up lane produces', async () => {
        const result = await verdict(AUTOMATED_LAND_MESSAGE + '\n');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
    }, 30_000);

    // `chore` is one of the allowed types — the land commit's type is allowed
    // by the policy, not waived by an `ignores` entry.
    it('accepts a chore commit — `chore` is one of the allowed types', async () => {
        const result = await verdict('chore: tidy the notes file\n');
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
    }, 30_000);

    // The land commit is machine-written, not exempt: a type outside the
    // allowed list is rejected exactly like a hand-written one. A blanket
    // `ignores` entry for the land subject shape would swallow every rule
    // (the body-length limit included) — there is no such entry.
    it('still rejects an automated land commit whose type is outside the allowed list', async () => {
        const result = await verdict(AUTOMATED_LAND_MESSAGE_WITH_DISALLOWED_TYPE + '\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[type-enum]');
    }, 30_000);

    // The other half of the same guard: no rule is waived for the land shape.
    // A body line over the limit fails the land commit too.
    it('still enforces the body-length limit on an automated land commit', async () => {
        const result = await verdict(AUTOMATED_LAND_MESSAGE_WITH_OVERLONG_BODY + '\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[body-max-line-length]');
    }, 30_000);

    // …and the subject rules apply to it as well.
    it('still enforces the subject rules on an automated land commit', async () => {
        const result = await verdict(AUTOMATED_LAND_MESSAGE_WITH_EMPTY_SUBJECT);
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[subject-empty]');
    }, 30_000);

    it('still rejects a scoped commit whose type is outside the allowed list', async () => {
        const result = await verdict('wip(babysit): drop the notes file\n');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('[type-enum]');
    }, 30_000);

    it('still judges a typed merge subject by the type policy', async () => {
        expect((await verdict('fix: repair the commit-message gate (#36)\n')).status).toBe(0);
    }, 30_000);
});
