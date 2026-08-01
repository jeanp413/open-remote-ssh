import { Log } from './common/logger';
import * as semver from 'semver';
import { ServerVersion } from './serverConfig';

type githubReleasesData = {
    name: string;
};

export type IRelease = {
    version: string;
    build: string;
};

export function splitRelease(release: string): IRelease {
    const regex = /(\d+)\.(\d+)\.(?:(\d+)\.(\d+)|(\d)(\d*))/;

    const match = release.match(regex);
    if (!match) {
        return {version: release, build: ''};
    }

    const [, major, minor, patch4, build4, patchFused, buildFused] = match;

    // Pre-1.99 release scheme
    // 4-part format: 1.96.4.25026 => patch=4, build=25026
    if (patch4 !== undefined && build4 !== undefined) {
        return {version: `${major}.${minor}.${patch4}`, build: build4};
    }

    // Release scheme starting with 1.99
    // 3-part fused format: 1.112.02593 => patch=0, build=2593
    // Can also catch version without build: 1.112.0 => patch=0, build=''
    return {version: `${major}.${minor}.${patchFused}`, build: buildFused ?? ''};
}

export async function fetchRelease(serverDownloadUrlTemplate: string, version: string, build: string, objective: ServerVersion, logger: Log): Promise<IRelease> {
    // Just match the given version/build
    if (objective === 'match') {
        return {version, build};
    }

    const downloadUrl = new URL(serverDownloadUrlTemplate);
    const hostname = downloadUrl.hostname;
    if (hostname !== 'github.com') {
        logger.info('Can only fetch releases on github repositories');
        return {version, build};
    }

    // Fetch github releases following: https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28
    logger.info(`Fetch the VSCodium release corresponding to the ${objective} release, with local version ${version}-${build}`);

    const parts = downloadUrl.pathname.split('/');
    if (parts.length < 3) {
        console.info('Cannot parse the Github repository from the url template: ' + downloadUrl);
        return {version, build};
    }
    const apiUrl = `https://api.github.com/repos/${parts[1]}/${parts[2]}/releases`;

    let found: IRelease | undefined;
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        const data = await response.json() as Array<githubReleasesData>;

        // Parse and sort all releases descending by semver,
        // using hyphen to separate the version from the build/release number.
        const releases = data
            .map(releaseInfo => splitRelease(releaseInfo.name))
            .filter(r => semver.valid(`${r.version}-${r.build}`))
            .sort((a, b) => semver.rcompare(
                `${a.version}-${a.build}`,
                `${b.version}-${b.build}`
            ));

        if (objective === 'latest') {
            // Latest version
            found = releases[0];
        } else if (objective === 'closest') {
            // Newest release whose version matches the requested version
            found = releases.find(r => r.version === version);
        } else {
            // Specific version+release or version match
            found = releases.find(r =>
                `${r.version}${r.build}` === objective ||
                (r.version === objective)
            );
        }

        // Add error message to help debugging
        if (!found) {
            logger.info(`Cannot find the ${objective} release from the list of existing releases: ${releases}`);
        }

    } catch (error) {
        logger.error('Error fetching releases:', error);
    }

    if (found) {
        logger.info(`Found release for "${objective}": ${found.version}-${found.build}`);
        return found;
    }

    logger.info(`No matching release found for "${objective}", falling back to the local version ${version}-${build}`);
    return {version, build};
}
