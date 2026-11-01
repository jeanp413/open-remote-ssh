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
            expect(scripts['postinstall']).toBe('npm run update:dts');
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
