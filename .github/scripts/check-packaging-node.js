#!/usr/bin/env node
'use strict';

// Release guard: the packaging toolchain (`vsce`, provided by the @vscode/vsce
// devDependency that `npm run package` invokes) ships transitive dependencies
// with their own `engines.node` floors. Those floors are stricter than the
// repo-wide Node policy in `.nvmrc` (Node 20): @vscode/vsce@3.9.2 pulls in
// @azure/identity and @azure/core-process, both of which require Node >= 22.
//
// `npm ci` only *warns* about an unmet engine floor (npm's `engine-strict` is
// off by default and the repo has no .npmrc), so an incompatible runtime used
// to reach `vsce package` and fail somewhere deep inside the toolchain with a
// confusing error — or worse, succeed while half the packaging path silently
// did not run. This script turns that warning into a hard, early failure.
//
// Engine ranges are evaluated per package with `semver.satisfies`, never
// collapsed into a single numeric floor: the tree contains disjunctive ranges
// (`18 || 20 || >=22`, `^20.19.0 || ^22.13.0 || >=24`) that a numeric
// comparison would get wrong. The reported floor is the true intersection —
// the lowest release admitted by *every* range — computed by testing release
// candidates against all ranges, not by comparing `semver.minVersion` values
// (which reports the lowest branch of a disjunctive range and may name a
// version no other range admits).
//
// Two scopes are checked, because the publish job does two things on this
// runtime: `npm ci` installs the whole locked tree (devDependencies included),
// and `npm run package` runs the @vscode/vsce tooling. The binding floor is
// the intersection of both.
//
// Usage:
//   node .github/scripts/check-packaging-node.js [--node-version <version>]
//
// `--node-version` forces the version under test (used by the unit test to
// prove the guard actually fails); the default is the running Node.

const fs = require('fs');
const path = require('path');
const semver = require('semver');

/** The devDependency that provides the `vsce` bin run by `npm run package`. */
const PACKAGING_ROOT = '@vscode/vsce';

const repoRoot = path.resolve(__dirname, '..', '..');
const lockPath = path.join(repoRoot, 'package-lock.json');

function readLock() {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
}

/**
 * Resolve a dependency name from a package's install location, following npm's
 * node_modules resolution walk: look in `<dir>/node_modules/<name>` first, then
 * walk up the ancestor chain towards the root.
 *
 * @param {Record<string, unknown>} packages the lockfile's `packages` map.
 * @param {string} fromDir the lock path of the requiring package ('' = root).
 * @param {string} name the dependency name to resolve.
 * @returns {string | undefined} the lock path of the resolved package.
 */
function resolvePackagePath(packages, fromDir, name) {
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

/**
 * The transitive closure of a dependency tree, following dependencies,
 * optionalDependencies and (optionally) devDependencies — all of which `npm ci`
 * installs by default and all of which therefore must run on a compatible
 * runtime.
 *
 * @param {Record<string, unknown>} packages the lockfile's `packages` map.
 * @param {string} rootPath lock path of the root package ('' = the repo root).
 * @param {boolean} includeDevDependencies whether devDependencies are followed.
 * @returns {Map<string, { name: string, version: string | undefined, nodeRange: string | undefined }>}
 */
function collectDependencyTree(packages, rootPath, includeDevDependencies) {
    const visited = new Map();
    const queue = [rootPath];

    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) {
            continue;
        }

        const entry = packages[current];
        if (!entry) {
            continue;
        }

        const name = current === ''
            ? ''
            : current.slice(current.lastIndexOf('node_modules/') + 'node_modules/'.length);
        const engines = entry.engines;
        const nodeRange = engines && typeof engines.node === 'string' ? engines.node : undefined;

        visited.set(current, {
            name,
            version: typeof entry.version === 'string' ? entry.version : undefined,
            nodeRange,
        });

        const dependencies = {
            ...(entry.dependencies && typeof entry.dependencies === 'object' ? entry.dependencies : {}),
            ...(entry.optionalDependencies && typeof entry.optionalDependencies === 'object' ? entry.optionalDependencies : {}),
        };

        if (includeDevDependencies && entry.devDependencies && typeof entry.devDependencies === 'object') {
            Object.assign(dependencies, entry.devDependencies);
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
 * Evaluate every `engines.node` range in the subtree against the runtime.
 *
 * @param {Map<string, { name: string, version: string | undefined, nodeRange: string | undefined }>} subtree
 * @param {string} nodeVersion the version to test.
 * @returns {Array<{ name: string, version: string | undefined, nodeRange: string }>} the violations.
 */
function findEngineViolations(subtree, nodeVersion) {
    const violations = [];

    for (const entry of subtree.values()) {
        if (entry.nodeRange === undefined) {
            continue;
        }
        if (!semver.satisfies(nodeVersion, entry.nodeRange, { includePrerelease: true })) {
            violations.push({ name: entry.name, version: entry.version, nodeRange: entry.nodeRange });
        }
    }

    violations.sort((a, b) => a.name.localeCompare(b.name));
    return violations;
}

/**
 * The effective engine floor of the subtree: the lowest Node version that
 * satisfies EVERY range in the tree.
 *
 * This is a real intersection, not a numeric comparison of per-range minima.
 * `semver.minVersion('18 || 20 || >=22')` returns 18.0.0 — the lowest branch of
 * a disjunctive range — which may be excluded outright by another range
 * (`>= 22.0.0` excludes it). Likewise, taking the maximum over raw minima
 * only ever yields one candidate; the true floor may sit on another branch of
 * a disjunctive range and on a higher major than any single range's minimum
 * (`^20.19.0 || ^22.13.0 || >=24` admits 22.13.x and 24.x but nothing in 23.x).
 *
 * So the floor is found by *testing release candidates against every range*
 * and narrowing until a candidate all of them admit is reached. Each range is
 * a union of branches (`18 || 20 || >=22` has three); when the current
 * candidate falls outside a range, the candidate is raised to the start of the
 * next branch that could still contain it. The narrowing is repeated until it
 * reaches a fixed point, which is the true intersection floor.
 *
 * @param {Map<string, { name: string, version: string | undefined, nodeRange: string | undefined }>} subtree
 * @returns {string | undefined} the floor, or undefined when the ranges have no common release.
 */
function effectiveEngineFloor(subtree) {
    const ranges = [];
    for (const entry of subtree.values()) {
        if (entry.nodeRange !== undefined) {
            ranges.push(entry.nodeRange);
        }
    }

    if (ranges.length === 0) {
        return undefined;
    }

    // Start from the highest per-range minimum: every range's floor is at
    // least its own minimum, so the intersection cannot be below the largest.
    let candidate;
    for (const range of ranges) {
        const minVersion = semver.minVersion(range);
        if (minVersion === null) {
            continue;
        }
        if (candidate === undefined || semver.gt(minVersion, candidate)) {
            candidate = minVersion;
        }
    }

    if (candidate === undefined) {
        return undefined;
    }

    // Narrow to a fixed point: whenever the candidate is excluded by a range,
    // raise it to the start of that range's next admissible branch.
    for (let iteration = 0; iteration < ranges.length + 1; iteration++) {
        let raised = false;

        for (const range of ranges) {
            if (semver.satisfies(candidate.version, range, { includePrerelease: true })) {
                continue;
            }

            let next;
            for (const branch of new semver.Range(range).set) {
                const branchMin = semver.minVersion(branch.map(comparator => comparator.value).join(' '));
                if (branchMin === null || semver.lte(branchMin, candidate)) {
                    continue;
                }
                if (next === undefined || semver.lt(branchMin, next)) {
                    next = branchMin;
                }
            }

            if (next === undefined) {
                // No branch of this range starts above the candidate: the ranges
                // have no common release.
                return undefined;
            }

            candidate = next;
            raised = true;
        }

        if (!raised) {
            return candidate.version;
        }
    }

    return candidate.version;
}

function parseNodeVersionArgument(argv) {
    const index = argv.indexOf('--node-version');
    if (index === -1) {
        return undefined;
    }
    const value = argv[index + 1];
    if (value === undefined) {
        throw new Error('--node-version requires a value');
    }
    return value;
}

function main(argv) {
    const forcedVersion = parseNodeVersionArgument(argv);
    const nodeVersion = forcedVersion !== undefined ? forcedVersion : process.versions.node;

    if (!semver.valid(nodeVersion)) {
        console.error(`Not a valid Node version: ${nodeVersion}`);
        process.exit(1);
    }

    const lock = readLock();
    const packages = lock.packages;
    if (!packages || typeof packages !== 'object') {
        console.error('package-lock.json has no "packages" map — cannot verify the packaging engine floors.');
        process.exit(1);
    }

    const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT);
    if (rootPath === undefined) {
        console.error(`package-lock.json has no ${PACKAGING_ROOT} entry — cannot verify the packaging engine floors.`);
        process.exit(1);
    }

    // Two scopes, because the publish job does two things on this runtime:
    //   1. `npm ci` installs the *whole* locked tree (dependencies,
    //      optionalDependencies and devDependencies alike) — every one of those
    //      packages must be installable and runnable without an EBADENGINE
    //      warning, so their floors bind the runtime too.
    //   2. `npm run package` runs the @vscode/vsce tooling — the packaging
    //      subtree's floors bind the runtime as well.
    // The binding floor is the intersection of both.
    const packagingSubtree = collectDependencyTree(packages, rootPath, false);
    const installedTree = collectDependencyTree(packages, '', true);

    const subtree = new Map(installedTree);
    for (const [path, entry] of packagingSubtree) {
        subtree.set(path, entry);
    }

    const violations = findEngineViolations(subtree, nodeVersion);
    const floor = effectiveEngineFloor(subtree);

    console.log(`Node version under test: ${nodeVersion}`);
    console.log(`Packaging subtree root:  ${PACKAGING_ROOT} (${packagingSubtree.size} packages)`);
    console.log(`Installed tree:          ${installedTree.size} packages (the whole tree npm ci installs)`);
    console.log(`Effective engine floor:  ${floor ?? 'none'}`);

    // The effective floor is the lowest release admitted by *every* range in
    // the subtree. A runtime below it is incompatible even when no single
    // range rejects it on its own — it is excluded by the intersection.
    const belowFloor = floor !== undefined && semver.lt(nodeVersion, floor, { includePrerelease: true });

    if (violations.length === 0 && !belowFloor) {
        console.log('OK: the running Node satisfies every engines.node range in the packaging subtree.');
        process.exit(0);
    }

    console.error(`FAIL: Node ${nodeVersion} does not satisfy the engine floors of the packaging subtree:`);
    for (const violation of violations) {
        const version = violation.version ? `@${violation.version}` : '';
        console.error(`  - ${violation.name}${version} requires node ${violation.nodeRange}`);
    }
    if (belowFloor) {
        console.error(`  - the packaging subtree's effective engine floor is node ${floor}, and Node ${nodeVersion} is below it`);
    }
    console.error('The release-packaging workflow must run on a Node version that satisfies these ranges.');
    process.exit(1);
}

// Exported for unit testing; the guard only runs when invoked directly.
module.exports = { effectiveEngineFloor, findEngineViolations, collectDependencyTree };

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
