import fetch from 'node-fetch';
import Log from './common/logger';

interface githubReleasesData {
    name: string;
}

export interface IRelease {
    version: string;
    release: string;
}

const VSCODIUM_URL = "https://api.github.com/repos/VSCodium/vscodium/releases";


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
    logger.info('Fetch the last release number of VSCodium corresponding to version ' + version);

    const repoRegex = new RegExp("/(?P<owner>[\w,\-,\_]+)/(?P<repo>[\w,\-,\_]+)/");
    const matches = downloadUrl.pathname.match(repoRegex);
    const apiUrl = `https://api.github.com/repos/${matches.group(1)}/${matches.group(2)}/releases`;

    let currentVersion = '';
    let currentRelease = '';
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

        for (let releaseInfo of data) {
            ({version: currentVersion, release: currentRelease} = splitRelease(releaseInfo.name));

            if (objective === 'latest') {
                logger.info(`found release for version: ${currentVersion} (${currentRelease})`);

                // Found the latest version
                break;

            } else if (objective === 'closest' && currentVersion === version) {
                logger.info(`found release for version: ${currentVersion} (${currentRelease})`);

                // Found a version match, it is the newest
                break;
            } else if (objective === releaseInfo.name || objective === version) {
                logger.info(`found release for version ${objective}: $(version) (${currentRelease})`);

                // Found a version match, it is the newest
                break;
            }
        }
    } catch (error) {
        logger.error('Error fetching releases:', error);
    }

    return {version: currentVersion, release: currentRelease};
}