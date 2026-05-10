import fetch from 'node-fetch';
import Log from './common/logger';
import * as semver from 'semver';

interface githubReleasesData {
    name: string;
}

export interface IRelease {
    version: string;
    release: string;
}


export function splitRelease(release: string): IRelease {
    const parts = release.split(".");
    if (parts.length === 4) {
        // Pre-1.99 release scheme
        return {version: parts.slice(0, 3).join("."), release: parts[3]}
    }
    // Release scheme starting with 1.99
    const versionParts = [parts[0], parts[1], parts[2].slice(0, 1)];
    return {version: versionParts.join("."), release: parts[2].slice(1)}
}


export async function fetchRelease(serverDownloadUrlTemplate: string, version: string, release: string, objective: string, logger: Log): Promise<IRelease> {
    // Just match the given version/release
    if (objective == 'match') {
        return {version, release};
    }

    const downloadUrl = new URL(serverDownloadUrlTemplate);
    const hostname = downloadUrl.hostname;
    if (hostname !== 'github.com') {
        logger.info('Can only fetch releases on github repositories');
        return {version, release};
    }

    // Fetch github releases following: https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28
    logger.info(`Fetch the VSCodium release corresponding to the ${objective} release with reference to ${version}`);

    const parts = downloadUrl.pathname.split("/");
    if (parts.length < 3) {
        console.info('Cannot parse the Github repository from the url template: ' + downloadUrl);
        return {version, release};
    }
    const apiUrl = `https://api.github.com/repos/${parts[1]}/${parts[2]}/releases`;

    let found: IRelease | undefined;
    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
        const data = await response.json() as Array<githubReleasesData>;

        // Parse and sort all releases descending by semver,
        // using hyphen to separate the version from the build/release number.
        const releases = data
            .map(releaseInfo => splitRelease(releaseInfo.name))
            .filter(r => semver.valid(`${r.version}-${r.release}`))
            .sort((a, b) => semver.rcompare(
                `${a.version}-${a.release}`,
                `${b.version}-${b.release}`
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
                `${r.version}${r.release}` === objective ||
                (r.version === objective)
            );
        }

    } catch (error) {
        logger.error('Error fetching releases:', error);
    }

    if (found) {
        logger.info(`Found release for "${objective}": ${found.version} (${found.release})`);
        return found;
    }

    logger.info(`No matching release found for "${objective}", falling back to input ${ {version, release} }`);
    return {version, release};
}