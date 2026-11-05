import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { satisfies } from 'semver';

// ssh2 terminates every SSH connection this extension makes, and it has a
// two-part history that must not silently repeat: it used to be pinned to a
// git fork (jeanp413/ssh2@a169f62) purely to carry one patch — ECDSA signature
// r/s values must be converted to minimal, positive DER INTEGERs before they
// reach OpenSSL — and that fork predated Terrapin strict-kex (CVE-2023-48795).
// It is now an exact npm registry pin (ssh2 has shipped strict-kex since
// 1.11.0), and the one patch the fork carried is re-applied to the installed
// tree by scripts/patch-ssh2.js, wired ahead of every consumer of that tree
// (postinstall, bundle, bundle:dev).
//
// These guards read the live package.json and package-lock.json — no fixture
// copy — so a regression trips a real assertion:
//   - the version stays an exact x.y.z pin at or above the strict-kex floor
//     (a range would float on the next `npm install`; a pre-1.11.0 resolution
//     reintroduces the Terrapin downgrade attack);
//   - no git+ spec survives in manifest or lockfile (a git resolution is one
//     the npm audit gate cannot match);
//   - the lockfile root mirrors the manifest byte-for-byte (exactly what
//     `npm ci` compares);
//   - the installed entry is the registry tarball with its SRI integrity and
//     the hasInstallScript flag npm needs to run ssh2's install script;
//   - every install/build entry point routes through the patcher, because a
//     path that skips it ships an ssh2 whose ECDSA host-key verification
//     fails whenever the high bit of r or s is set — the very bug the fork
//     existed to fix.
//
// The real-protocol behaviour of the patched tree is asserted separately, in
// test/ssh/ssh2.security.test.ts.

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.resolve(repoRoot, 'package.json');
const packageLockJsonPath = path.resolve(repoRoot, 'package-lock.json');

interface JsonObject {
    [key: string]: unknown;
}

function readPackageJson(): JsonObject {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

/** The repo's package-lock.json, read live so a drifted pin fails here instead of at `npm ci`. */
function readPackageLockJson(): JsonObject {
    const raw = fs.readFileSync(packageLockJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

describe('ssh2 dependency (exact npm registry pin + patch wiring)', () => {
    const pkg = readPackageJson();
    const dependencies = pkg.dependencies as Record<string, string>;
    const scripts = pkg.scripts as Record<string, string>;
    const pin = dependencies['ssh2'];

    // The SRI digest the registry publishes for the pinned tarball; the exact
    // x.y.z pin asserted below makes the tarball, and therefore this digest,
    // fixed — so a hand-edited or mis-merged lockfile entry cannot describe a
    // different tarball under this version's name.
    const REGISTRY_INTEGRITY =
        'sha512-wPldCk3asibAjQ/kziWQQt1Wh3PgDFpC0XpwclzKcdT1vql6KeYxf5LIt4nlFkUeR8WuphYMKqUA56X4rjbfgQ==';

    it('pins ssh2 to an exact registry version at or above the strict-kex floor', () => {
        expect(pin, 'ssh2 must stay a runtime dependency of the extension').toBeDefined();
        // An exact pin, not a range: a caret would let the next `npm install`
        // float the resolved version and the lockfile stops being a
        // deterministic assertion of what ships.
        expect(pin, 'ssh2 must be an exact x.y.z pin, never a range').toMatch(/^\d+\.\d+\.\d+$/);
        expect(
            pin,
            'this suite pins the migration target itself — a deliberate re-pin updates it alongside the lockfile'
        ).toMatch(/^1\.17\.0$/);
        // 1.11.0 is the first ssh2 release advertising Terrapin strict-kex
        // (kex-strict-*-v00@openssh.com, CVE-2023-48795); anything below it
        // reintroduces the downgrade attack the old git fork predated.
        expect(satisfies(pin!, '>=1.11.0'), 'the pin must satisfy the strict-kex floor >=1.11.0 (CVE-2023-48795)').toBe(true);
    });

    it('resolves ssh2 from the npm registry, never a git URL', () => {
        expect(
            pin!.startsWith('git+'),
            'ssh2 must not go back to a git+ URL — the audit gate and npm ci both key on registry resolutions'
        ).toBe(false);

        // Belt and braces over the raw bytes: no `"ssh2": "git+..."` spec may
        // reappear anywhere in the manifest or the lockfile (an overrides
        // entry, a mis-merged mirror, anything).
        const rawManifest = fs.readFileSync(packageJsonPath, 'utf8');
        expect(rawManifest, 'a git+ spec for ssh2 reappeared in package.json').not.toMatch(/"ssh2"\s*:\s*"git\+/);
        const rawLock = fs.readFileSync(packageLockJsonPath, 'utf8');
        expect(rawLock, 'a git+ spec for ssh2 reappeared in package-lock.json').not.toMatch(/"ssh2"\s*:\s*"git\+/);
    });

    // The lockfile root mirror is exactly what `npm ci` compares package.json
    // against — one drifted character and CI fails with "lock file does not
    // satisfy package.json". Pin the mirror byte-for-byte so that failure
    // happens here, at test time.
    it('the lockfile root mirrors the manifest pin byte-for-byte, so npm ci installs exactly this version', () => {
        const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;
        const root = lockPackages[''];
        expect(root, 'package-lock.json is missing its packages[""] root entry').toBeDefined();
        const rootDependencies = (root!.dependencies as Record<string, string> | undefined) ?? {};
        expect(rootDependencies['ssh2'], 'lockfile root dependencies does not mirror the ssh2 manifest pin').toBe(pin);
    });

    it('the installed entry resolves to the registry tarball this pin names, with SRI integrity', () => {
        const lockPackages = readPackageLockJson().packages as Record<string, JsonObject>;
        const installed = lockPackages['node_modules/ssh2'];
        expect(installed, 'package-lock.json has no node_modules/ssh2 entry').toBeDefined();

        expect(installed!.version, 'installed ssh2 version differs from the manifest pin').toBe(pin);
        // The registry URL is what makes npm audit cover ssh2 — audit matches
        // advisory feeds on registry name@version, which a git resolution never gets.
        expect(
            installed!.resolved,
            'ssh2 must resolve to the npm registry tarball for the pinned version'
        ).toMatch(/^https:\/\/registry\.npmjs\.org\/ssh2\/-\/ssh2-1\.17\.0\.tgz$/);
        expect(
            (installed!.resolved as string).startsWith('git+'),
            'the resolved URL must never be a git+ URL'
        ).toBe(false);
        expect(installed!.integrity, 'ssh2 integrity must be a sha512 SRI digest').toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
        expect(
            installed!.integrity,
            'the lockfile integrity must be exactly the registry digest for ssh2 1.17.0 — a different digest means the lockfile does not describe the pinned tarball'
        ).toBe(REGISTRY_INTEGRITY);
        // ssh2 fetches optional native bindings from an install script; npm only
        // runs it when the lockfile records the package as having one.
        expect(
            installed!.hasInstallScript,
            "node_modules/ssh2 must keep hasInstallScript — without it npm ci skips ssh2's install script"
        ).toBe(true);
    });

    // scripts/patch-ssh2.js re-applies the one fork patch (ECDSA sigSSHToASN1
    // minimal positive mpints, fail-closed on truncated signatures) to the
    // installed tree. Every entry point that consumes that tree — install,
    // production bundle, dev bundle — must route through it, or a fresh
    // checkout builds an extension carrying unpatched ssh2. Shape-based on
    // purpose: what each script does *after* the patcher is the other
    // guards' business.
    it.each(['postinstall', 'bundle', 'bundle:dev'])('routes %s through scripts/patch-ssh2.js', script => {
        expect(scripts[script], `${script} must run the ssh2 patcher before anything consumes the installed tree`)
            .toMatch(/^node scripts\/patch-ssh2\.js\b/);
    });
});
