import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { satisfies } from 'semver';

const root = path.resolve(__dirname, '..');
const guardPath = path.join(root, '.github', 'scripts', 'check-packaging-node.js');
const packageLockJsonPath = path.join(root, 'package-lock.json');

/** The devDependency that provides the `vsce` bin `npm run package` invokes. */
const PACKAGING_ROOT = '@vscode/vsce';

interface GuardModule {
    effectiveEngineFloor(subtree: Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>): string | undefined;
}

// The guard is a plain CommonJS script (package.json declares no "type"), so
// it is loaded through createRequire to unit-test its floor computation.
const nodeRequire = createRequire(__filename);
const guard = nodeRequire(guardPath) as GuardModule;

/** Build a fake dependency tree carrying the given engines.node ranges. */
function treeWithRanges(ranges: string[]): Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }> {
    const tree = new Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>();
    ranges.forEach((nodeRange, index) => {
        tree.set(`pkg-${index}`, { name: `pkg-${index}`, version: '1.0.0', nodeRange });
    });
    return tree;
}

/**
 * A major-only pin ('22') is resolved by setup-node to the *latest* release of
 * that major. It is therefore safe when the top of the major is admitted by
 * every range — the latest 22.x always is, even though 22.0.0 is not.
 */
function majorOnlyPinIsAdmitted(major: string, ranges: string[]): boolean {
    const latestOfMajor = `${major}.999.999`;
    return ranges.every(range => satisfies(latestOfMajor, range));
}

interface JsonObject {
    [key: string]: unknown;
}

interface LockEntry {
    version?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

/** The repo's package-lock.json, read live so a pin that drifted from the lockfile fails here. */
function readPackageLockJson(): JsonObject {
    return JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8')) as JsonObject;
}

function lockPackages(): Record<string, LockEntry> {
    return readPackageLockJson().packages as Record<string, LockEntry>;
}

/**
 * Resolve a dependency name from a package's install location the way npm does:
 * look in `<dir>/node_modules/<name>` first, then walk up towards the root.
 */
function resolvePackagePath(packages: Record<string, LockEntry>, fromDir: string, name: string): string | undefined {
    const segments = fromDir === '' ? [] : fromDir.split('/node_modules/');

    for (let depth = segments.length; depth >= 0; depth--) {
        const prefix = segments.slice(0, depth).join('/node_modules/');
        const candidate = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
        if (Object.prototype.hasOwnProperty.call(packages, candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/** The transitive closure of the packaging subtree (dependencies + optionalDependencies). */
function collectPackagingSubtree(packages: Record<string, LockEntry>, rootPath: string): Map<string, LockEntry> {
    return collectDependencyTree(packages, rootPath, false);
}

/**
 * The transitive closure of a dependency tree. `includeDevDependencies` is set
 * for the whole installed tree, because `npm ci` installs devDependencies too
 * and every one of those packages must run on a compatible runtime.
 */
function collectDependencyTree(
    packages: Record<string, LockEntry>,
    rootPath: string,
    includeDevDependencies: boolean,
): Map<string, LockEntry> {
    const visited = new Map<string, LockEntry>();
    const queue = [rootPath];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) {
            continue;
        }
        const entry = packages[current];
        if (!entry) {
            continue;
        }
        visited.set(current, entry);

        const dependencies = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
        if (includeDevDependencies) {
            Object.assign(dependencies, entry.devDependencies ?? {});
        }
        for (const dependencyName of Object.keys(dependencies)) {
            const resolved = resolvePackagePath(packages, current, dependencyName);
            if (resolved !== undefined && !visited.has(resolved)) {
                queue.push(resolved);
            }
        }
    }

    return visited;
}

/**
 * The tree the guard actually checks: the whole tree `npm ci` installs, plus
 * the @vscode/vsce packaging subtree that `npm run package` runs.
 *
 * Returned in the guard's own shape (`nodeRange`), so the guard's floor
 * computation is exercised with exactly the input it sees in production.
 */
function collectGuardedTree(
    packages: Record<string, LockEntry>,
    rootPath: string,
): Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }> {
    const tree = new Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>();

    const add = (path: string, entry: LockEntry): void => {
        const name = path === ''
            ? ''
            : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        tree.set(path, {
            name,
            version: entry.version,
            nodeRange: entry.engines?.node,
        });
    };

    for (const [path, entry] of collectDependencyTree(packages, '', true)) {
        add(path, entry);
    }
    for (const [path, entry] of collectPackagingSubtree(packages, rootPath)) {
        add(path, entry);
    }
    return tree;
}

function subtreeEntry(packages: Record<string, LockEntry>, lockPath: string): LockEntry | undefined {
    return packages[lockPath];
}

function runGuard(nodeVersion: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [guardPath, '--node-version', nodeVersion], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('publish runtime engine contract', () => {
    const packages = lockPackages();

    describe('locked packaging subtree', () => {
        it('pins @vscode/vsce as the packaging root and resolves it in the lockfile', () => {
            const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT);
            expect(rootPath, `package-lock.json has no ${PACKAGING_ROOT} entry`).toBeDefined();
            expect(subtreeEntry(packages, rootPath!)!.version).toBe('3.9.2');
        });

        it('contains @azure/identity@4.14.1 and @azure/core-process@1.0.0 with engines.node ">=22.0.0"', () => {
            const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT)!;
            const subtree = collectPackagingSubtree(packages, rootPath);

            const identity = subtree.get('node_modules/@azure/identity');
            expect(identity, '@azure/identity is not in the @vscode/vsce subtree').toBeDefined();
            expect(identity!.version).toBe('4.14.1');
            expect(identity!.engines?.node).toBe('>=22.0.0');

            const coreProcess = subtree.get('node_modules/@azure/core-process');
            expect(coreProcess, '@azure/core-process is not in the @vscode/vsce subtree').toBeDefined();
            expect(coreProcess!.version).toBe('1.0.0');
            expect(coreProcess!.engines?.node).toBe('>=22.0.0');
        });

        it('has an effective binding engine floor of 22.13.0', () => {
            const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT)!;
            const subtree = collectGuardedTree(packages, rootPath);

            // The floor is the lowest release admitted by EVERY range in the
            // tree — a real intersection, not the maximum of per-range minima.
            // The Azure packages (>=22.0.0) are not the binding constraint:
            // the devDependency ranges (`^20.19.0 || ^22.13.0 || >=24`) exclude
            // Node 22.0.0 while admitting 22.13.0.
            const excludedByTransitive = [...subtree.entries()].filter(
                ([, entry]) => entry.nodeRange !== undefined
                    && !satisfies('22.0.0', entry.nodeRange),
            );

            expect(
                excludedByTransitive.length,
                'no locked range excludes Node 22.0.0 — the floor would be lower'
            ).toBeGreaterThan(0);

            // Every one of those ranges must admit 22.13.0, or the floor is stricter.
            const stricter = excludedByTransitive
                .filter(([, entry]) => !satisfies('22.13.0', entry.nodeRange!))
                .map(([path, entry]) => `${path} requires node ${entry.nodeRange}`);

            expect(
                stricter,
                `the locked tree declares ranges stricter than Node 22.13.0: ${stricter.join(', ')}`
            ).toEqual([]);

            // 22.13.0 satisfies every range in the tree, 22.0.0 does not.
            const allRanges = [...subtree.values()]
                .map(entry => entry.nodeRange)
                .filter((range): range is string => range !== undefined);
            expect(allRanges.every(range => satisfies('22.13.0', range))).toBe(true);
            expect(satisfies('22.0.0', '>=22.0.0')).toBe(true);
        });
    });

    describe('check-packaging-node.js guard', () => {
        // The floor must be the true intersection of the ranges — the lowest
        // release admitted by ALL of them. Collapsing the tree to a numeric
        // minimum (or to `semver.minVersion` of a disjunctive range, which
        // reports its lowest branch) admits versions no other range allows.
        it('computes the floor as the intersection of the ranges, not a numeric minimum', () => {
            // `18 || 20 || >=22` has minVersion 18.0.0, which `>=22.0.0` rejects;
            // the floor is the version both ranges admit.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>= 20', '>=22.0.0', '18 || 20 || >=22'])))
                .toBe('22.0.0');

            // The floor can sit on a higher major than any single range's minimum.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>=22.0.0', '18 || 20 || >=23'])))
                .toBe('23.0.0');

            // And on a later minor of a branch: 22.13.0 is admitted, 23.x is not.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>=22.0.0', '^20.19.0 || ^22.13.0 || >=24'])))
                .toBe('22.13.0');
        });

        it('fails with a non-zero exit naming the offending package and its range on an incompatible Node', () => {
            const result = runGuard('20.20.2');

            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('@azure/identity@4.14.1');
            expect(result.stderr).toContain('>=22.0.0');
            expect(result.stderr).toContain('@azure/core-process@1.0.0');
            expect(result.stderr).toContain('>=22.0.0');
        });

        it('exits zero on a compatible Node 22 LTS runtime', () => {
            const result = runGuard('22.13.0');

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('OK:');
            expect(result.stdout).toContain('Effective engine floor:  22.13.0');
        });

        it('exits zero on a Node 24 runtime', () => {
            const result = runGuard('24.0.0');

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('OK:');
        });

        // Regression: Node 22.0.0 satisfies the Azure `>=22.0.0` floors but is
        // excluded by a transitive range (`^20.19.0 || ^22.13.0 || >=24`),
        // so it must be rejected even though the Azure packages accept it.
        it('rejects Node 22.0.0, which satisfies only the Azure floors', () => {
            const result = runGuard('22.0.0');

            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('FAIL: Node 22.0.0');
            expect(result.stderr).toContain('^20.19.0 || ^22.13.0 || >=24');
        });

        // The lockfile contains disjunctive engine ranges (`18 || 20 || >=22`,
        // `20 || >=22`). A guard that collapsed the tree to a single numeric floor
        // and compared would accept Node 21, which those ranges exclude.
        it('rejects a Node version excluded only by a disjunctive range', () => {
            const result = runGuard('21.0.0');

            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('||');
        });
    });

    describe('release-packaging workflows', () => {
        const workflowFiles = [
            path.join(root, '.github', 'workflows', 'publish.yml'),
            path.join(root, '.github', 'workflows', 'preview.yml'),
        ];

        it.each(workflowFiles)('pins an engine-compatible Node in %s instead of resolving .nvmrc', (file) => {
            const contents = fs.readFileSync(file, 'utf8');

            expect(contents, `${file} must not resolve the packaging Node from .nvmrc`).not.toContain('node-version-file: .nvmrc');

            const pinned = /node-version:\s*'?([^'\s]+)'?/.exec(contents);
            expect(pinned, `${file} has no explicit node-version`).not.toBeNull();

            const version = pinned![1];

            const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT)!;
            const guarded = collectGuardedTree(packages, rootPath);
            const ranges = [...guarded.values()]
                .map(entry => entry.nodeRange)
                .filter((range): range is string => range !== undefined);

            const floor = guard.effectiveEngineFloor(guarded);
            expect(floor, 'the locked tree has no common engine floor').toBeDefined();

            if (/^\d+$/.test(version)) {
                // A major-only spec ('22'): setup-node resolves it to the latest
                // release of that major, which must be admitted by every range.
                expect(
                    majorOnlyPinIsAdmitted(version, ranges),
                    `${file} pins Node ${version}, whose latest release is not admitted by every locked engine range`
                ).toBe(true);
            }
            else {
                expect(
                    satisfies(version, `>=${floor}`),
                    `${file} pins Node ${version}, which is below the packaging floor ${floor}`
                ).toBe(true);
            }
        });

        it.each(workflowFiles)('runs the guard before the packaging step in %s', (file) => {
            const contents = fs.readFileSync(file, 'utf8');

            const guardIndex = contents.indexOf('node .github/scripts/check-packaging-node.js');
            expect(guardIndex, `${file} does not run the packaging engine guard`).toBeGreaterThan(-1);

            const buildIndex = contents.indexOf('npm run package');
            expect(buildIndex, `${file} has no packaging step`).toBeGreaterThan(-1);

            expect(
                guardIndex,
                `${file} runs the guard after the packaging step — the incompatible runtime must be caught first`
            ).toBeLessThan(buildIndex);
        });

        it('pins the same Node version in both workflows', () => {
            const versions = workflowFiles.map(file => {
                const contents = fs.readFileSync(file, 'utf8');
                return /node-version:\s*'?([^'\s]+)'?/.exec(contents)?.[1];
            });

            expect(versions[0], 'publish.yml has no node-version').toBeDefined();
            expect(versions[1], 'preview.yml has no node-version').toBeDefined();
            expect(versions[0]).toBe(versions[1]);
        });
    });

    describe('unchanged policies', () => {
        it('keeps the repo-wide Node policy on .nvmrc at v20.20.2', () => {
            expect(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()).toBe('v20.20.2');
        });

        it('leaves the extension\'s engines.vscode untouched and declares no node engine', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
                engines: Record<string, string>;
            };

            expect(pkg.engines.vscode).toBe('^1.70.2');
            expect(pkg.engines.node, 'the extension must not declare a node engine').toBeUndefined();
        });
    });
});
