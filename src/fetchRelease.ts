import fetch from 'node-fetch';
import Log from './common/logger';


interface githubReleasesData {
    name: string;
}

export async function fetchRelease(version: string, logger: Log): Promise<string> {

    // Fetch github releases following: https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28
    logger.info('Fetch the last release number of VSCodium corresponding to version ' + version);

    let release = '';
    try {
        const response = await fetch("https://api.github.com/repos/VSCodium/vscodium/releases", {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        });
        const data = await response.json() as Array<githubReleasesData>;
        let fullVersion: string;
        for (let releaseInfo of data) {
            fullVersion = releaseInfo.name;
            if (fullVersion.startsWith(version)) {
                logger.info('found release version: ' + fullVersion);

                // Found a version match, it is the newer
                // Remove the version and the dot '.': 1.96.4.25026 -> 25026
                release = fullVersion.slice(version.length + 1);
                break;
            }
        }
    } catch (error) {
        logger.error('Error fetching releases:', error);
    }

    return release;
}