import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { satisfies } from 'semver';
import { KILL_WORKSPACE_SESSIONS_COMMAND_ID } from '../src/commands';
import { TMUX_PROFILE_ID, TMUX_PROFILE_TITLE } from '../src/extension';

// Drift guard: package.json's `contributes` is hand-authored and easy to let go
// stale (settings renamed/typo'd, a command's id changed in one place but not the
// other). These tests read the manifest itself — no fixture copy — so a future
// edit to package.json or src/*.ts registrations trips a real assertion instead of
// silently drifting apart.

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.resolve(repoRoot, 'package.json');
const srcDir = path.resolve(repoRoot, 'src');

interface JsonObject {
    [key: string]: unknown;
}

function readPackageJson(): JsonObject {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

const packageLockJsonPath = path.resolve(repoRoot, 'package-lock.json');

/** The repo's package-lock.json, read live so a pin that drifted from the lockfile fails here instead of at `npm ci`. */
function readPackageLockJson(): JsonObject {
    const raw = fs.readFileSync(packageLockJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

/** Recursively collect every `.ts` file under `dir` (source only, no `.d.ts`). */
function collectTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTsFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            files.push(entryPath);
        }
    }
    return files;
}

/** Recursively collect every `.md` file under `dir`. */
function collectAllMarkdownFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAllMarkdownFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(entryPath);
        }
    }
    return files;
}

/**
 * Every `export const NAME = '<string literal>'` in `src/`, so a `registerCommand(NAME)`
 * call (an identifier, not an inline literal — e.g. the kill command, which shares its
 * id with `commands.ts`'s exported constant per this task's requirement) can be
 * resolved back to the id it registers.
 */
function exportedStringConstants(): Map<string, string> {
    const constants = new Map<string, string>();
    const exportedConst = /export const (\w+)\s*=\s*(['"])([^'"]+)\2/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(exportedConst)) {
            constants.set(match[1], match[3]);
        }
    }
    return constants;
}

/**
 * Every command id passed as the first argument to a `registerCommand(` call across
 * `src/` — whether an inline string literal or an identifier referencing an exported
 * `const` (resolved via {@link exportedStringConstants}).
 */
function registeredCommandIds(): Set<string> {
    const ids = new Set<string>();
    const constants = exportedStringConstants();
    const registerCommandCall = /registerCommand\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(registerCommandCall)) {
            const [, , literal, identifier] = match;
            if (literal !== undefined) {
                ids.add(literal);
            } else if (identifier !== undefined && constants.has(identifier)) {
                ids.add(constants.get(identifier)!);
            }
        }
    }
    return ids;
}

/** Concatenation of every `src/*.ts` file's contents, for simple substring/regex drift
 * guards that don't care which file a match lives in. */
function allSrcContents(): string {
    return collectTsFiles(srcDir).map(file => fs.readFileSync(file, 'utf8')).join('\n');
}

describe('package.json manifest drift guard', () => {
    const pkg = readPackageJson();
    const contributes = pkg.contributes as JsonObject;
    const configuration = contributes.configuration as JsonObject;
    const properties = configuration.properties as Record<string, JsonObject>;
    const commands = contributes.commands as Array<{ command: string }>;

    describe('tmux settings', () => {
        it('declares remote.SSH.tmux.enabled with the documented default', () => {
            const enabled = properties['remote.SSH.tmux.enabled'];
            expect(enabled).toBeDefined();
            expect(enabled.type).toBe('string');
            expect(enabled.default).toBe('auto');
            expect(enabled.enum).toEqual(['auto', 'off', 'on']);
        });

        it('declares remote.SSH.tmux.historyLimit with the documented default', () => {
            const historyLimit = properties['remote.SSH.tmux.historyLimit'];
            expect(historyLimit).toBeDefined();
            expect(historyLimit.type).toBe('number');
            expect(historyLimit.default).toBe(50000);
        });

        it('declares remote.SSH.tmux.reapOnConnect with the documented default', () => {
            const reapOnConnect = properties['remote.SSH.tmux.reapOnConnect'];
            expect(reapOnConnect).toBeDefined();
            expect(reapOnConnect.type).toBe('boolean');
            expect(reapOnConnect.default).toBe(true);
        });

        it('every remote.SSH.tmux.* setting mentioned in docs/ exists in package.json', () => {
            // Collect all `remote.SSH.tmux.*` setting names from docs/
            const docsDir = path.resolve(repoRoot, 'docs');
            const allMarkdownFiles = collectAllMarkdownFiles(docsDir);

            const mentionedSettingsInDocs = new Set<string>();
            const tmuxSettingRegex = /remote\.SSH\.tmux\.\w+/g;

            for (const file of allMarkdownFiles) {
                const contents = fs.readFileSync(file, 'utf8');
                for (const match of contents.matchAll(tmuxSettingRegex)) {
                    mentionedSettingsInDocs.add(match[0]);
                }
            }

            // Verify each setting is present in package.json
            const missingSettings: string[] = [];
            for (const setting of mentionedSettingsInDocs) {
                if (!properties[setting]) {
                    missingSettings.push(setting);
                }
            }

            expect(
                missingSettings,
                `These remote.SSH.tmux.* settings are mentioned in docs/ but missing from package.json configuration: ${missingSettings.join(', ')}`
            ).toEqual([]);
        });

        // Reverse of the guard above: catches a setting shipped in package.json that nobody
        // documented (the forward guard at :126 only catches docs promising a setting that
        // doesn't exist; this one catches a setting existing that docs never mention).
        it('every remote.SSH.tmux.* setting in package.json is mentioned in docs/', () => {
            const docsDir = path.resolve(repoRoot, 'docs');
            const allMarkdownFiles = collectAllMarkdownFiles(docsDir);
            const docsContents = allMarkdownFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');

            const tmuxSettingKeys = Object.keys(properties).filter(key => key.startsWith('remote.SSH.tmux.'));
            expect(tmuxSettingKeys.length).toBeGreaterThan(0);

            const undocumented = tmuxSettingKeys.filter(key => !docsContents.includes(key));

            expect(
                undocumented,
                `These remote.SSH.tmux.* settings exist in package.json but are never mentioned in docs/: ${undocumented.join(', ')}`
            ).toEqual([]);
        });

        // Would have caught the two dead tmux settings shipped in 1.0.0: declared in
        // package.json but never read by any `config.get(...)` call in src/, so changing
        // them from the Settings UI silently did nothing.
        it('every remote.SSH.tmux.* setting in package.json is read by a config.get(...) call in src/', () => {
            const tmuxSettingKeys = Object.keys(properties).filter(key => key.startsWith('remote.SSH.tmux.'));
            expect(tmuxSettingKeys.length).toBeGreaterThan(0);

            const srcContents = allSrcContents();
            const unread = tmuxSettingKeys.filter(key => {
                // `getConfiguration('remote.SSH')` sections off the `remote.SSH.` prefix, so
                // the read call only needs to reference the `tmux.*` suffix (e.g. `tmux.enabled`).
                const suffix = key.replace(/^remote\.SSH\./, '');
                const readCall = new RegExp(`\\.get(?:<[^>]*>)?\\(\\s*['"]${suffix.replace(/\./g, '\\.')}['"]`);
                return !readCall.test(srcContents);
            });

            expect(
                unread,
                `These remote.SSH.tmux.* settings are declared in package.json but never read via config.get(...) in src/: ${unread.join(', ')}`
            ).toEqual([]);
        });

        // Would have caught a declared enum value (e.g. a new `'on'`/`'off'`/`'auto'` state)
        // that the handling code in extension.ts never actually branches on.
        it('every declared remote.SSH.tmux.enabled enum value is handled in src/extension.ts', () => {
            const enabled = properties['remote.SSH.tmux.enabled'];
            const enumValues = enabled.enum as string[];
            expect(enumValues.length).toBeGreaterThan(0);

            const extensionSrc = fs.readFileSync(path.resolve(srcDir, 'extension.ts'), 'utf8');
            const unhandled = enumValues.filter(value => !extensionSrc.includes(`'${value}'`));

            expect(
                unhandled,
                `These remote.SSH.tmux.enabled enum values are declared but never referenced in src/extension.ts: ${unhandled.join(', ')}`
            ).toEqual([]);
        });
    });

    describe('activation events', () => {
        it('includes onTerminalProfile:tmux to activate when the tmux profile is requested', () => {
            const activationEvents = pkg.activationEvents as string[] | undefined;
            expect(activationEvents, 'activationEvents is missing').toBeDefined();
            expect(activationEvents!.some(e => e === 'onTerminalProfile:tmux')).toBe(true);
        });

        // `engines.vscode` (^1.70.2) predates VS Code's implicit-activation-events cutoff
        // (~1.74), so every command that can actually be invoked before the extension is
        // otherwise activated needs its own `onCommand:<id>` entry — pins the 06 fix
        // (`onCommand:openremotessh.tmux.killWorkspaceSessions` was missing, breaking
        // palette invocation pre-1.74). Commands hidden from the palette via a
        // `"when": "false"` `menus.commandPalette` entry are view-only (context
        // menu/inline icon) — they can't be reached until the view is visible, which
        // already activates the extension via `onView:sshHosts`, so they're exempt.
        it('every palette-invokable command has a matching onCommand activation event', () => {
            const activationEvents = pkg.activationEvents as string[] | undefined;
            expect(activationEvents, 'activationEvents is missing').toBeDefined();

            const menus = contributes.menus as JsonObject | undefined;
            const commandPaletteEntries = (menus?.commandPalette ?? []) as Array<{ command: string; when?: string }>;
            const paletteExempt = new Set(
                commandPaletteEntries.filter(e => e.when === 'false').map(e => e.command)
            );

            const missing = commands
                .map(c => c.command)
                .filter(id => !paletteExempt.has(id))
                .filter(id => !activationEvents!.includes(`onCommand:${id}`));

            expect(
                missing,
                `These palette-invokable commands have no matching onCommand:<id> activation event: ${missing.join(', ')}`
            ).toEqual([]);
        });
    });

    describe('tmux terminal profile', () => {
        // Regression coverage for a real 09-verify bug: contributes.terminal.profiles
        // (the actual VS Code extension point: contributes.terminal -> {profiles: []})
        // had been mis-authored as a top-level `"terminal.profiles"` key shaped like a
        // *settings* schema — an unrecognized contribution point VS Code silently
        // ignores, so `registerTerminalProfileProvider('tmux', ...)` (src/extension.ts)
        // never had a matching profile and was a no-op: "New Terminal" launched a plain
        // shell, zero tmux sessions on the remote. Caught empirically in the 09
        // acceptance matrix (row 1), fixed alongside this test.
        it('contributes a real contributes.terminal.profiles entry (not a stray top-level key)', () => {
            expect(contributes['terminal.profiles'], 'contributes["terminal.profiles"] is not a real VS Code extension point — it is silently ignored').toBeUndefined();

            const terminal = contributes.terminal as JsonObject | undefined;
            expect(terminal, 'contributes.terminal is missing').toBeDefined();
            const profiles = terminal!.profiles as Array<{ id: string; title: string }> | undefined;
            expect(profiles, 'contributes.terminal.profiles is missing').toBeDefined();
            expect(profiles!.some(p => p.id === 'tmux')).toBe(true);
        });

        // The id the provider is registered under now comes from TMUX_PROFILE_ID (the
        // single owner, TerminalProfileRegistration, takes it once) rather than a literal
        // at the register call site — so pin the constant against the manifest directly
        // instead of grepping source text, exactly as the title guard below does.
        it('the contributed profile id matches TMUX_PROFILE_ID in src/extension.ts', () => {
            const terminal = contributes.terminal as JsonObject;
            const profiles = terminal.profiles as Array<{ id: string; title: string }>;
            expect(profiles.some(p => p.id === TMUX_PROFILE_ID)).toBe(true);
        });

        // Guards the regression this whole registration owner exists for: two direct
        // registerTerminalProfileProvider calls on the same contributed id is exactly how
        // v1.0.0 shipped — VS Code throws "already registered" on the second, the tmux
        // layer never wired, and "Persistent Shell" silently opened a plain bash terminal.
        // src/ must route registration through TerminalProfileRegistration, whose single
        // call site is profileRegistration.ts.
        it('registers the profile id in exactly one place (the registration owner)', () => {
            // Comments are stripped first: the guard is about calls in *code*, and the
            // modules explaining this very regression name the API in their prose.
            const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            const callers = fs.readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
                .filter(file => file.endsWith('.ts'))
                .filter(file => /registerTerminalProfileProvider\s*\(/.test(stripComments(fs.readFileSync(path.resolve(srcDir, file), 'utf8'))));
            expect(callers, 'registerTerminalProfileProvider must be called only by tmux/profileRegistration.ts')
                .toEqual(['tmux/profileRegistration.ts']);
        });

        // The default-profile reconcile (extension.ts) selects/clears the tmux profile by
        // its *title* (`terminal.integrated.defaultProfile.linux` is a title, not an id) —
        // would have caught the contributed title silently diverging from
        // TMUX_PROFILE_TITLE, which would break that reconcile without any type error.
        it('the contributed profile title matches TMUX_PROFILE_TITLE in src/extension.ts', () => {
            const terminal = contributes.terminal as JsonObject;
            const profiles = terminal.profiles as Array<{ id: string; title: string }>;
            const tmuxProfile = profiles.find(p => p.id === 'tmux');
            expect(tmuxProfile, 'no contributed profile with id "tmux"').toBeDefined();
            expect(tmuxProfile!.title).toBe(TMUX_PROFILE_TITLE);
        });
    });

    // The typings acquisition (`update:dts`) used to run `npx vscode-dts dev && npx
    // vscode-dts main`: an undeclared tool fetched from the registry at install time,
    // pulling typings from upstream's *moving* `main` branch — every reinstall silently
    // re-based the extension against whatever the vscode repo had shipped that day, so
    // builds were unreproducible and could break under our feet with no change of our
    // own. It now runs the declared, exactly-pinned `@vscode/dts` CLI (bin `dts`) — the
    // old `vscode-dts` name is deprecated upstream and drags an unpatchable glob@7 tree
    // the npm-audit commit gate rejects. These guards pin the three things that keep it
    // that way: the tool is an exactly-pinned devDependency the lockfile agrees on; the
    // install chain routes through the script (so `npm ci` acquires nothing undeclared);
    // and every invocation fetches from a *literal* VS Code release that satisfies
    // engines.vscode. Deliberately shape-based: the exact tool version and the exact
    // release are free to move, as long as they stay exact-pinned and engines-compatible.
    describe('dts acquisition', () => {
        const scripts = pkg.scripts as Record<string, string>;
        const devDependencies = pkg.devDependencies as Record<string, string>;
        const engines = pkg.engines as Record<string, string>;

        it('pins @vscode/dts as an exact devDependency', () => {
            const pin = devDependencies['@vscode/dts'];
            expect(pin, '@vscode/dts must be declared as a devDependency (build-time tool, not a runtime dep)').toBeDefined();
            expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
        });

        it('the lockfile mirrors the exact pin (root devDependencies and the installed package agree)', () => {
            const pin = devDependencies['@vscode/dts'];
            const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;
            const root = lockPackages[''];
            const installed = lockPackages['node_modules/@vscode/dts'];

            expect(root, 'package-lock.json is missing its packages[""] root entry').toBeDefined();
            const rootDev = (root!.devDependencies as Record<string, string> | undefined) ?? {};
            expect(rootDev['@vscode/dts'], 'lockfile root devDependencies does not mirror the @vscode/dts pin').toBe(pin);
            expect(
                (root!.dependencies as Record<string, string> | undefined)?.['@vscode/dts'],
                '@vscode/dts is mirrored under lockfile dependencies — it must stay a devDependency'
            ).toBeUndefined();
            expect(installed, 'package-lock.json has no node_modules/@vscode/dts entry').toBeDefined();
            expect(installed!.version, 'installed @vscode/dts version differs from the manifest pin').toBe(pin);
        });

        // The pre-rename `vscode-dts` package is deprecated upstream and its tree carries
        // glob@7/minimatch findings with no in-range fix — `npm audit` (which gates every
        // commit via lint-staged) fails the moment it is reintroduced. Keep it out for good.
        it('the deprecated vscode-dts package stays removed from both manifest and lockfile', () => {
            expect(devDependencies['vscode-dts'], 'vscode-dts is deprecated for @vscode/dts — do not reintroduce it').toBeUndefined();
            expect((pkg.dependencies as Record<string, string> | undefined)?.['vscode-dts']).toBeUndefined();
            const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;
            expect(lockPackages['node_modules/vscode-dts'], 'stale node_modules/vscode-dts entry in the lockfile').toBeUndefined();
        });

        it('routes postinstall through npm run update:dts and invokes the installed binary, never npx', () => {
            // The ssh2 patcher now runs ahead of the typings step (its wiring is
            // guarded by test/package-ssh2.test.ts); the dts routing itself is unchanged.
            expect(scripts['postinstall']).toBe('node scripts/patch-ssh2.js && npm run update:dts');
            // The installed binary's name is `dts` (@vscode/dts's bin); `vscode-dts` is the
            // deprecated pre-rename package and must not come back in any form.
            expect(scripts['update:dts']).toMatch(/\bdts\b/);
            expect(scripts['update:dts']).not.toMatch(/\bnpx\b/);
            expect(scripts['update:dts']).not.toMatch(/vscode-dts/);
        });

        it('fetches typings from a literal VS Code release at every invocation, engines-compatible', () => {
            const updateDts = scripts['update:dts'];

            // A bare `dts dev` / `main` (no version) is the moving upstream channel
            // again — just through the installed binary instead of npx — so *each* `&&`
            // segment must carry its own literal x.y.z release, not merely the script
            // overall.
            const segments = updateDts.split('&&');
            const bareChannel = segments.filter(segment => !/\b\d+\.\d+\.\d+\b/.test(segment));
            expect(
                bareChannel,
                `every update:dts invocation must name a literal x.y.z VS Code release; these are moving-channel fetches: ${bareChannel.map(s => s.trim()).join(' && ')}`
            ).toEqual([]);

            const releaseTokens = updateDts.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
            expect(releaseTokens.length, 'update:dts must name a literal x.y.z VS Code release').toBeGreaterThan(0);

            const enginesVscode = engines.vscode;
            const offRange = releaseTokens.filter(release => !satisfies(release, enginesVscode));
            expect(
                offRange,
                `update:dts fetches from releases that engines.vscode (${enginesVscode}) does not allow: ${offRange.join(', ')}`
            ).toEqual([]);
        });
    });

    // The git-sourced runtime dependency (simple-socks) used to sit on upstream's
    // *moving* branch ref (`#main`): every `npm install` or `taze` refresh silently
    // re-resolved it to whatever upstream had pushed that day — the same
    // unreproducible-install class the dts guards above fix for the typings
    // toolchain, except it ships inside the extension and carries the proxy path of
    // every SSH connection. It is now pinned to an exact commit SHA. (Its former
    // neighbour ssh2 moved to an exact npm registry pin — strict-kex /
    // CVE-2023-48795 — and is guarded by test/package-ssh2.test.ts, not here.)
    // These guards keep the pin in place and keep the three copies in agreement —
    // manifest spec, lockfile root mirror (what `npm ci` validates the manifest
    // against), installed resolved URL. Deliberately shape-based: *which* commit is
    // pinned is free to move via a deliberate re-pin (edit the manifest,
    // `npm install`), as long as it stays a full 40-hex commit everywhere.
    describe('git dependency pins (simple-socks)', () => {
        const dependencies = pkg.dependencies as Record<string, string>;
        // Package name and upstream repo happen to be identical; the owner is
        // part of the pin — this fork (transport fixes) lives in jeanp413's repo, not npm.
        const gitPins = [
            { name: 'simple-socks', repo: 'simple-socks' }
        ];

        /** The manifest spec for `name`, asserted to be a git+https URL pinned to a full 40-hex commit (no branch/tag fragment). */
        function pinnedSpec(name: string, repo: string): { spec: string; sha: string } {
            const spec = dependencies[name];
            expect(spec, `${name} must stay a runtime dependency of the extension`).toBeDefined();

            const sha = spec!.match(new RegExp(`^git\\+https://github\\.com/jeanp413/${repo}#([0-9a-f]{40})$`))?.[1];
            expect(
                sha,
                `${name} must be pinned to an exact commit — expected git+https://github.com/jeanp413/${repo}#<40-hex-sha>, got "${spec ?? ''}"; a branch/tag fragment (e.g. #main) silently re-resolves on every npm install / taze run`
            ).toBeDefined();
            return { spec: spec!, sha: sha! };
        }

        it('pins each git dependency to an exact 40-hex commit, never a branch/tag ref', () => {
            for (const { name, repo } of gitPins) {
                pinnedSpec(name, repo);
            }
        });

        // The lockfile root mirror is exactly what `npm ci` compares package.json against —
        // one drifted character and CI fails with "lock file does not satisfy package.json".
        // Pin the mirror byte-for-byte so that failure happens here, at test time.
        it('the lockfile root mirrors each manifest pin byte-for-byte, so npm ci installs exactly these commits', () => {
            const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;
            const root = lockPackages[''];
            expect(root, 'package-lock.json is missing its packages[""] root entry').toBeDefined();
            const rootDependencies = (root!.dependencies as Record<string, string> | undefined) ?? {};

            for (const { name, repo } of gitPins) {
                const { spec } = pinnedSpec(name, repo);
                expect(rootDependencies[name], `lockfile root dependencies does not mirror the ${name} manifest spec`).toBe(spec);
            }
        });

        it('the installed package resolves to the same commit each manifest pin names', () => {
            const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;

            for (const { name, repo } of gitPins) {
                const { sha } = pinnedSpec(name, repo);
                const installed = lockPackages[`node_modules/${name}`];
                expect(installed, `package-lock.json has no node_modules/${name} entry`).toBeDefined();

                // Transport-agnostic on purpose: npm records the resolved URL in git+ssh
                // form while the manifest keeps git+https — the property that must hold is
                // same repo, same commit, not npm's choice of transport spelling.
                const resolved = installed!.resolved as string | undefined;
                expect(resolved, `node_modules/${name} has no resolved URL in the lockfile`).toBeDefined();
                expect(
                    resolved,
                    `node_modules/${name} resolves to a commit other than the manifest pin (${sha}) — the tree npm ci installs is not the code the manifest pins; re-run npm install so they agree`
                ).toMatch(new RegExp(`github\\.com[/:]jeanp413/${repo}(\\.git)?#${sha}$`));
            }
        });
    });

    it('the kill command\'s manifest id matches the constant exported by commands.ts', () => {
        const killCommand = commands.find(c => c.command === KILL_WORKSPACE_SESSIONS_COMMAND_ID);
        expect(killCommand, `expected contributes.commands to contain "${KILL_WORKSPACE_SESSIONS_COMMAND_ID}"`).toBeDefined();
    });

    it('every contributes.commands id is backed by a real registerCommand(...) call in src/', () => {
        const registered = registeredCommandIds();
        const missing = commands
            .map(c => c.command)
            .filter(id => !registered.has(id));

        expect(missing, `command ids with no matching registerCommand(...) in src/: ${missing.join(', ')}`).toEqual([]);
    });

    describe('fork identity', () => {
        it('is named open-remote-ssh-tmux', () => {
            expect(pkg.name).toBe('open-remote-ssh-tmux');
        });

        it('is published under the fork org, not upstream\'s jeanp413', () => {
            expect(pkg.publisher).not.toBe('jeanp413');
            expect(pkg.publisher).toBe('developerz-ai');
        });

        it('repository url points at the fork org, not upstream jeanp413/open-remote-ssh', () => {
            const repository = pkg.repository as JsonObject;
            expect(repository.url).toContain('developerz-ai/open-remote-ssh-tmux');
            expect(repository.url).not.toContain('jeanp413/open-remote-ssh.git');
        });
    });
});

// Drift guard for the root `overrides` map in package.json.
//
// npm's supported representation of `overrides` deliberately does NOT include an
// `overrides` key in package-lock.json — npm never writes one. The observable
// evidence that a root override is in effect is therefore NOT a lockfile key but
// the *shape of the resolved tree*:
//
//   - the overridden package is hoisted to the top level, at
//     `node_modules/<name>`, at exactly the pinned version;
//   - and no nested `node_modules/<parent>/node_modules/<name>` copy exists — a
//     nested copy means the override's constraint was lost for that dependent
//     (npm satisfies every dependent with the hoisted override, so a nested copy
//     is a real resolution drift, not a legitimate tree shape).
//
// This matters because neither `npm ci` nor `npm audit` can see a lost override:
// `npm ci` validates package.json's dependencies/devDependencies against
// `packages[""]` (not against `overrides`), and `npm audit`'s shape only reports
// the resolved versions. A lockfile that silently resolves `undici` to an
// overridden-away version installs an advisory-affected tree without any
// command complaining. These assertions read the live manifest and lockfile —
// no fixture copy — so a future `npm install` that loses an override trips a
// real assertion instead of drifting apart silently.
//
// Deliberately shape-based: *which* version is pinned is free to move via a
// deliberate re-pin (edit package.json, `npm install`), as long as it stays an
// exact x.y.z pin and the lockfile agrees with it. Advisory floors below also
// prevent an agreeing manifest and lockfile from pinning a vulnerable version.
describe('root dependency overrides', () => {
    const overrides = (readPackageJson().overrides ?? {}) as Record<string, string>;

    // The advisories this repository deliberately overrides, pinned here as an
    // explicit list rather than derived from the manifest. Every check below
    // is driven by the keys the manifest declares, so an `overrides` map that
    // lost a key (e.g. `undici`) would narrow those checks to the survivors
    // and pass vacuously — the package the lost key covered would be free to
    // drift back to its advisory-affected version, and neither `npm ci` nor
    // `npm audit` reports that. Only the *names* are pinned here: *which*
    // version each one resolves to stays free to move via a deliberate
    // re-pin (edit package.json, `npm install`).
    const EXPECTED_OVERRIDE_NAMES = ['basic-ftp', 'glob', 'minimatch', 'undici'];

    /**
     * The pins the checks below run against: the manifest's `overrides` map,
     * asserted to still cover every advisory in {@link EXPECTED_OVERRIDE_NAMES}.
     * The assertion sits at the point of use, so dropping a key fails the
     * resolution checks themselves instead of quietly narrowing them.
     */
    function pinsUnderTest(): Record<string, string> {
        const missing = EXPECTED_OVERRIDE_NAMES.filter(name => !(name in overrides));
        expect(
            missing,
            `These advisories are no longer overridden in package.json: ${missing.join(', ')} — the checks below only cover the keys the manifest declares, so a dropped override would let its package drift without failing this suite`
        ).toEqual([]);
        return overrides;
    }

    // The two guard rules live here, once, as pure functions over a lockfile's
    // `packages` map. They are deliberately parameterised by the resolved tree
    // ALONE — they never receive, read or depend on an `overrides` key, because
    // npm never writes one into package-lock.json. Every assertion below is
    // driven through these same functions, so "the verdict is the same with and
    // without such a key" is a property of the code under test rather than of
    // two hand-inlined copies that could drift apart.
    type LockPackages = Record<string, JsonObject>;

    interface OverrideDrift {
        name: string;
        pinned: string;
        locked: string | undefined;
    }

    /**
     * Rule 1: the lockfile's supported representation of an override is the
     * top-level `node_modules/<name>` entry's version. A mismatch means the
     * lockfile resolved a different version than the manifest pins — the tree
     * `npm ci` installs is not the tree the manifest asked for.
     */
    function overrideVersionDrift(packages: LockPackages, pins: Record<string, string>): OverrideDrift[] {
        return Object.entries(pins)
            .map(([name, pinned]) => {
                const installed = packages[`node_modules/${name}`];
                return { name, pinned, locked: installed?.version as string | undefined };
            })
            .filter(({ pinned, locked }) => locked !== pinned);
    }

    /**
     * Rule 2: a nested copy of an overridden package means the override was lost
     * for that dependent — npm hoists the overridden version to the top of the
     * tree and satisfies every dependent with it, so a nested copy is a
     * resolution drift, not a legitimate tree shape.
     */
    function nestedOverrideCopies(packages: LockPackages, pins: Record<string, string>): string[] {
        const nested: string[] = [];
        for (const location of Object.keys(packages)) {
            for (const name of Object.keys(pins)) {
                if (location.endsWith(`/node_modules/${name}`) && location !== `node_modules/${name}`) {
                    nested.push(`${location} (overridden: ${name})`);
                }
            }
        }
        return nested;
    }

    /** Require the upstream patched release, independently of npm's advisory feed. */
    function basicFtpAdvisoryViolations(packages: LockPackages, pins: Record<string, string>): string[] {
        const versions: Record<string, unknown> = {
            'overrides.basic-ftp': pins['basic-ftp'],
            'node_modules/basic-ftp': packages['node_modules/basic-ftp']?.version,
        };
        for (const [location, installed] of Object.entries(packages)) {
            if (location.endsWith('/node_modules/basic-ftp')) {
                versions[location] = installed.version;
            }
        }
        return Object.entries(versions)
            .filter(([, version]) => typeof version !== 'string' || !satisfies(version, '>=6.2.6'))
            .map(([location, version]) => `${location}: ${String(version)}`);
    }

    // GHSA-2w5v-vj22-jp27 names 6.2.6 as patched; do not infer 6.2.5 is safe
    // from its affected-range header. This also covers GHSA-5rfr-xx34-2xxv
    // (<=6.2.1, patched in 6.2.2). Equality with the manifest is not sufficient.
    it('requires basic-ftp >=6.2.6 in the manifest and every lockfile copy', () => {
        const violations = basicFtpAdvisoryViolations(readPackageLockJson().packages as LockPackages, pinsUnderTest());
        expect(violations, `basic-ftp must be >=6.2.6: ${violations.join('; ')}`).toEqual([]);
    });

    it.each(['6.2.1', '6.2.5'])('rejects basic-ftp %s in either the manifest or resolved tree', version => {
        const patchedPackages = { 'node_modules/basic-ftp': { version: '6.2.6' } };
        const vulnerablePackages = { 'node_modules/basic-ftp': { version } };
        expect(basicFtpAdvisoryViolations(patchedPackages, { 'basic-ftp': version }))
            .toEqual([`overrides.basic-ftp: ${version}`]);
        expect(basicFtpAdvisoryViolations(vulnerablePackages, { 'basic-ftp': '6.2.6' }))
            .toEqual([`node_modules/basic-ftp: ${version}`]);
        expect(basicFtpAdvisoryViolations(vulnerablePackages, { 'basic-ftp': version }))
            .toEqual([`overrides.basic-ftp: ${version}`, `node_modules/basic-ftp: ${version}`]);
    });

    it.each(['6.2.1', '6.2.5'])('rejects a nested basic-ftp %s even when the pin and hoisted copy are patched', version => {
        const packages = {
            'node_modules/basic-ftp': { version: '6.2.6' },
            'node_modules/get-uri/node_modules/basic-ftp': { version },
        };
        expect(basicFtpAdvisoryViolations(packages, { 'basic-ftp': '6.2.6' }))
            .toEqual([`node_modules/get-uri/node_modules/basic-ftp: ${version}`]);
    });

    it('rejects a missing basic-ftp override even when the resolution is patched', () => {
        expect(basicFtpAdvisoryViolations({ 'node_modules/basic-ftp': { version: '6.2.6' } }, {}))
            .toEqual(['overrides.basic-ftp: undefined']);
    });

    it('rejects a missing hoisted basic-ftp resolution even when a patched nested copy exists', () => {
        const pins = { 'basic-ftp': '6.2.6' };
        expect(basicFtpAdvisoryViolations({}, pins))
            .toEqual(['node_modules/basic-ftp: undefined']);
        expect(basicFtpAdvisoryViolations({ 'node_modules/get-uri/node_modules/basic-ftp': { version: '6.2.6' } }, pins))
            .toEqual(['node_modules/basic-ftp: undefined']);
    });

    it.each(['', 'not-a-version', '6.2', '^6.2.6', '>=6.2.6'])('rejects malformed basic-ftp version %j in the pin', version => {
        expect(basicFtpAdvisoryViolations({ 'node_modules/basic-ftp': { version: '6.2.6' } }, { 'basic-ftp': version }))
            .toEqual([`overrides.basic-ftp: ${version}`]);
    });

    it.each(['', 'not-a-version', '6.2', '^6.2.6', '>=6.2.6', undefined, null, 626])(
        'rejects malformed basic-ftp version %j in hoisted and nested resolutions', version => {
            const pins = { 'basic-ftp': '6.2.6' };
            expect(basicFtpAdvisoryViolations({ 'node_modules/basic-ftp': { version } }, pins))
                .toEqual([`node_modules/basic-ftp: ${String(version)}`]);
            const packages = {
                'node_modules/basic-ftp': { version: '6.2.6' },
                'node_modules/get-uri/node_modules/basic-ftp': { version },
            };
            expect(basicFtpAdvisoryViolations(packages, pins))
                .toEqual([`node_modules/get-uri/node_modules/basic-ftp: ${String(version)}`]);
        }
    );

    it('accepts the patched basic-ftp 6.2.6 pin and resolution', () => {
        expect(basicFtpAdvisoryViolations({ 'node_modules/basic-ftp': { version: '6.2.6' } }, { 'basic-ftp': '6.2.6' }))
            .toEqual([]);
    });

    // The set of overridden advisories is this guard's own expectation, so it
    // cannot be read back from the manifest it polices: dropping `undici`
    // from `overrides` would leave every check below iterating the three
    // survivors, and the suite would stay green while the locked `undici`
    // version drifted back to its advisory-affected version.
    it('overrides every advisory this repository pins', () => {
        pinsUnderTest();
    });

    // A range ("^6.2.0", ">=6") is not a pin: it lets the next `npm install`
    // float the resolved version and the lockfile's top-level entry stops being
    // a deterministic assertion of the constraint.
    it('pins every override to an exact x.y.z version', () => {
        const notExact = Object.entries(pinsUnderTest())
            .filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version))
            .map(([name, version]) => `${name}@${version}`);

        expect(
            notExact,
            `These overrides are not exact x.y.z pins: ${notExact.join(', ')}`
        ).toEqual([]);
    });

    // The lockfile's supported representation of the override: the top-level
    // `node_modules/<name>` entry's version. A mismatch means the lockfile
    // resolved a different version than the manifest pins — the tree `npm ci`
    // installs is not the tree the manifest asked for.
    it('locks every override at the top level to the pinned version', () => {
        const lockPackages = readPackageLockJson().packages as LockPackages;

        const drifted = overrideVersionDrift(lockPackages, pinsUnderTest());

        expect(
            drifted,
            `These overrides are not honoured by the lockfile (top-level node_modules/<name> entry does not carry the pinned version): ${drifted.map(d => `${d.name} pinned ${d.pinned}, locked ${d.locked ?? 'missing'}`).join('; ')}`
        ).toEqual([]);
    });

    // A nested copy of an overridden package means the override was lost for that
    // dependent: npm hoists the overridden version to the top of the tree and
    // satisfies every dependent with it, so a nested copy is a resolution drift.
    it('has no nested copy of an overridden package in the lockfile', () => {
        const lockPackages = readPackageLockJson().packages as LockPackages;

        const nested = nestedOverrideCopies(lockPackages, pinsUnderTest());

        expect(
            nested,
            `These nested copies of an overridden package mean the override was lost for that dependent: ${nested.join(', ')}`
        ).toEqual([]);
    });

    // A guard that cannot fail is not a guard. Pin the *failure* direction too:
    // move a locked top-level version off its pin and the guard must report the
    // drift rather than pass silently. Driven on a synthetic copy of the real
    // lockfile so the committed files are never touched.
    it('fails when a locked top-level version drifts off the override pin', () => {
        const lockPackages = readPackageLockJson().packages as LockPackages;
        const pins = pinsUnderTest();

        // Every advisory this repository pins, not just whichever key happens
        // to come first in the manifest — the guard has to be shown to catch a
        // drift on each of them.
        for (const name of EXPECTED_OVERRIDE_NAMES) {
            const pinned = pins[name];
            const driftedPackages: LockPackages = {
                ...lockPackages,
                [`node_modules/${name}`]: { version: '0.0.0-drifted' },
            };

            const drifted = overrideVersionDrift(driftedPackages, pins);

            expect(
                drifted.map(d => d.name),
                `a locked version moved off its override pin must be reported as drift (${name})`
            ).toContain(name);
            expect(
                drifted.find(d => d.name === name),
                'the reported drift must name the pinned version and the version actually locked'
            ).toMatchObject({ pinned, locked: '0.0.0-drifted' });
        }
    });

    // Same for the nested-copy rule: introducing a nested copy of an overridden
    // package must trip the guard, not slip past it.
    it('fails when a nested copy of an overridden package appears in the lockfile', () => {
        const lockPackages = readPackageLockJson().packages as LockPackages;
        const pins = pinsUnderTest();

        for (const name of EXPECTED_OVERRIDE_NAMES) {
            const nestedLocation = `node_modules/some-parent/node_modules/${name}`;
            const driftedPackages: LockPackages = {
                ...lockPackages,
                [nestedLocation]: { version: '0.0.0-drifted' },
            };

            const nested = nestedOverrideCopies(driftedPackages, pins);

            expect(
                nested,
                'a nested copy of an overridden package must be reported'
            ).toContain(`${nestedLocation} (overridden: ${name})`);
        }
    });

    // npm never writes an `overrides` key into package-lock.json, so its absence
    // is NOT an installation failure and must never fail this guard — asserting
    // the key's presence would be a guard that can only ever fail. The checks
    // above must reach their verdict from the resolved tree alone, with or
    // without such a key. Prove it on two INDEPENDENTLY parsed fixtures: the
    // real lockfile (no `overrides` key) and a separate parse of the same bytes
    // with an `overrides` key added. Both must reach the same verdict — and the
    // fixtures are distinct objects, so a difference could actually surface.
    it('reaches its verdict without an "overrides" key in the lockfile (npm never writes one)', () => {
        const lock = readPackageLockJson();
        const lockPackages = lock.packages as LockPackages;

        // Fixture A: the real lockfile, which carries no `overrides` key.
        expect(
            lock.overrides,
            'npm never writes an "overrides" key into package-lock.json — if this ever appears, npm changed its representation and this guard must be revisited'
        ).toBeUndefined();

        // Fixture B: an independent parse of the same lockfile bytes, with an
        // `overrides` key added. A separate parse (not a shallow spread of the
        // object above) so the two fixtures are genuinely distinct objects and
        // the comparison below is not a tautology.
        const withKeyLock = JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8')) as JsonObject;
        withKeyLock.overrides = pinsUnderTest();
        const withKeyPackages = withKeyLock.packages as LockPackages;

        expect(
            withKeyLock.packages,
            'the two fixtures must be distinct objects, otherwise the comparison below is vacuous'
        ).not.toBe(lockPackages);

        // The verdict must be identical whether the lockfile happens to carry an
        // `overrides` key or not — npm does not write one, so a guard that read
        // it would be reading a key that is not there. Adding one must change
        // nothing: the resolved tree is the only input.
        expect(
            overrideVersionDrift(withKeyPackages, pinsUnderTest()),
            'adding an "overrides" key must not change the verdict'
        ).toEqual(overrideVersionDrift(lockPackages, pinsUnderTest()));

        expect(
            nestedOverrideCopies(withKeyPackages, pinsUnderTest()),
            'adding an "overrides" key must not change the verdict'
        ).toEqual(nestedOverrideCopies(lockPackages, pinsUnderTest()));
    });
});

describe('README fork identity', () => {
    const readme = fs.readFileSync(path.resolve(repoRoot, 'README.md'), 'utf8');

    it('references the fork\'s own extension id', () => {
        expect(readme).toContain('developerz-ai.open-remote-ssh-tmux');
    });

    it('does not tell users to allowlist upstream\'s jeanp413.open-remote-ssh id', () => {
        expect(readme).not.toContain('jeanp413.open-remote-ssh"');
        expect(readme).not.toContain('jeanp413.open-remote-ssh\'');
    });
});

describe('CHANGELOG', () => {
    it('has a first heading that parses as valid semver via get-changelog logic', () => {
        const changelog = fs.readFileSync(path.resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
        const firstHeading = changelog.match(/^## (\d+\.\d+\.\d+)/m);
        expect(firstHeading, 'CHANGELOG.md must start with a "## x.y.z" heading').not.toBeNull();

        const version = firstHeading![1];
        const versionRegex = new RegExp(`## ${version}([^#]|#(?!#))*(?=## |$)`, 's');
        const match = changelog.match(versionRegex);
        expect(match, `get-changelog regex found no section for ${version}`).not.toBeNull();

        const notes = match![0].replace(/^## \d+\.\d+\.\d+\n/, '').trim();
        expect(notes.length).toBeGreaterThan(0);
    });

    // The release workflow tags `v<package.json version>` and then asks
    // .github/scripts/get-changelog.js for that exact section (`## <version>`) to build the
    // release body — a missing section fails the publish job *after* the tag is already
    // pushed. Pinning the head of the CHANGELOG to the manifest version catches a bump that
    // forgot its entry (or an entry that forgot its bump) at test time instead. Deliberately
    // a drift guard rather than a hardcoded version: this file should not need editing every
    // release.
    it('first heading matches the version in package.json', () => {
        const changelog = fs.readFileSync(path.resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
        const firstHeading = changelog.match(/^## (\d+\.\d+\.\d+)/m);
        expect(firstHeading![1]).toBe(readPackageJson().version);
    });
});
