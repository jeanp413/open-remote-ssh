import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Log } from './common/logger';
import { getVSCodeServerConfig, IServerConfig, ServerVersion, ServerValidation } from './serverConfig';
import SSHConnection from './ssh/sshConnection';
import { fetchRelease, IRelease } from './fetchRelease';
import { sanitizeExtensionIds } from './utils/sanitize-extension-ids';

/**
 * Reads a script template from <extensionPath>/scripts/<templateName> and
 * replaces every %%KEY%% occurrence with the matching value from `variables`.
 */
function compileTemplate(templateName: string, variables: Record<string, string>, extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'src', 'scripts', templateName);
    let content = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(variables)) {
        content = content.replace(new RegExp(`%%${key}%%`, 'g'), value);
    }
    return content;
}

/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === '*') {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
    serverPlatform: Platform;
    serverArch: Architecture;
};

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: unknown;
};

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

export type LocalServerDownload = 'auto' | 'always' | 'never';
export type Platform = 'alpine' | 'dragonfly' | 'freebsd' | 'linux' | 'macos' | 'windows';
export type Architecture = 'arm64' | 'armhf' | 'loong64' | 'ppc64le' | 'riscv64' | 's390x' | 'x64';
export type Shell = 'cmd' | 'powershell' | 'bash';

type RemotePlatformInfo = {
    platform: Platform;
    arch: Architecture;
    shell: Shell;
};

async function detectRemotePlatform(conn: SSHConnection, platform: Platform | undefined, logger: Log): Promise<RemotePlatformInfo> {
    let shell: 'cmd' | 'powershell' | 'bash' = 'bash';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');
        const stdout = result.stdout.trim();

        if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
                shell = 'powershell';
            } else if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            } else {
                throw new Error(`Cannot execute "uname -s", yields: ${result.stderr}`);
            }
        } else if(stdout.length === 0) {
            throw new Error(`"uname -s" yields empty result`);
        } else if (stdout.includes('windows32')) {
            platform = 'windows';
            shell = 'powershell';
        } else if (stdout.includes('MINGW64')) {
            platform = 'windows';
            shell = 'bash';
        } else if (stdout === 'Darwin') {
            platform = 'macos';
        } else if (stdout === 'Linux') {
            platform = 'linux';
        } else if (stdout === 'FreeBSD') {
            platform = 'freebsd';
        } else if (stdout === 'DragonFly') {
            platform = 'dragonfly';
        } else {
            throw new Error(`platform not supported: ${stdout}`);
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    let arch: Architecture;

    if (platform === 'windows') {
        arch = 'x64';
    } else {
        const result = await conn.exec('uname -m');
        const stdout = result.stdout.trim();

        if (result.stderr) {
            throw new Error(`Cannot execute "uname -m", yields: ${result.stderr}`);
        } else if(stdout.length === 0) {
            throw new Error(`"uname -m" yields empty result`);
        } else {
            switch (stdout) {
                case 'x86_64':
                case 'amd64':
                    arch = 'x64';
                    break;
                case 'armv7l':
                case 'armv8l':
                    arch = 'armhf';
                    break;
                case 'arm64':
                case 'aarch64':
                    arch = 'arm64';
                    break;
                case 'ppc64le':
                    arch = 'ppc64le';
                    break;
                case 'riscv64':
                    arch = 'riscv64';
                    break;
                case 'loongarch64':
                    arch = 'loong64';
                    break;
                case 's390x':
                    arch = 's390x';
                    break;
                default:
                    throw new Error(`architecture not supported: ${stdout}`);
            }
        }
    }

    if (arch) {
        logger.trace(`Detected architecture: ${arch}`);
    }

    return { platform, arch, shell };
}

function buildServerDownloadUrl(
    template: string,
    quality: string,
    version: string,
    commit: string,
    platform: string,
    arch: string,
    release: string
): string {
    return template
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, platform)
        .replace(/\$\{arch\}/g, arch)
        .replace(/\$\{release\}/g, release);
}

async function downloadServerLocally(
    downloadUrl: string,
    commit: string,
    logger: Log
): Promise<string> {
    logger.info(`Downloading server binary locally from: ${downloadUrl}`);

    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`Failed to download server binary: ${response.status} ${response.statusText}`);
    }

    const tmpPath = path.join(os.tmpdir(), `vscode-server-${commit}.tar.gz`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(tmpPath, buffer);

    logger.info(`Server binary downloaded locally to: ${tmpPath}`);
    return tmpPath;
}

async function uploadServerBinary(
    conn: SSHConnection,
    localPath: string,
    remotePath: string,
    logger: Log
): Promise<void> {
    logger.info(`Uploading server binary via SFTP to: ${remotePath}`);
    await conn.putFile(localPath, remotePath);
    logger.info(`Server binary uploaded successfully`);
}

function isRemoteDownloadFailure(stdout: string, stderr: string): boolean {
    const combined = `${stdout}\n${stderr}`;
    return combined.includes('Error downloading server from') ||
        combined.includes('Error no tool to download server binary') ||
        combined.includes('Error while installing the server binary');
}

export async function installCodeServer(
    conn: SSHConnection,
    serverDownloadUrlTemplate: string | undefined,
    serverVersion: ServerVersion,
    extensionIds: string[],
    envVariables: string[],
    platform: Platform | undefined,
    useSocketPath: boolean,
    customInstallPath: string | undefined,
    logger: Log,
    extensionPath: string,
    localServerDownload: LocalServerDownload = 'auto'
): Promise<ServerInstallResult> {
    const {
        platform: detectedPlatform,
        arch: detectedArch,
        shell: detectedShell,
    } = await detectRemotePlatform(conn, platform, logger);

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();

    // Get the version and release
    const serverDownloadUrlTemplateFinal = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    const bestRelease: IRelease = await fetchRelease(serverDownloadUrlTemplateFinal, vscodeServerConfig.version, vscodeServerConfig.release, serverVersion, logger);

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: bestRelease.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: bestRelease.build,
        extensionIds: sanitizeExtensionIds(extensionIds),
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        serverValidation: vscodeServerConfig.serverValidation,
        serverPlatform: detectedPlatform,
        serverArch: detectedArch,
    };

    let commandOutput: { stdout: string; stderr: string };

    if (localServerDownload === 'always') {
        logger.info('localServerDownload is always, downloading server binary locally and uploading via SFTP');
        await downloadAndUploadServerBinary(conn, serverDownloadUrlTemplateFinal, vscodeServerConfig, bestRelease, detectedPlatform, detectedArch, customInstallPath, logger);
        commandOutput = await runInstallScript(conn, detectedPlatform, installOptions, detectedShell, vscodeServerConfig, scriptId, logger, extensionPath);
    } else if (localServerDownload === 'never') {
        commandOutput = await runInstallScript(conn, detectedPlatform, installOptions, detectedShell, vscodeServerConfig, scriptId, logger, extensionPath);
    } else {
        // auto: try remote download first, fall back to local download + SFTP on failure
        commandOutput = await runInstallScript(conn, detectedPlatform, installOptions, detectedShell, vscodeServerConfig, scriptId, logger, extensionPath);

        if (isRemoteDownloadFailure(commandOutput.stdout, commandOutput.stderr)) {
            logger.info('Remote server download failed, falling back to local download and SFTP upload');
            await downloadAndUploadServerBinary(conn, serverDownloadUrlTemplateFinal, vscodeServerConfig, bestRelease, detectedPlatform, detectedArch, customInstallPath, logger);
            commandOutput = await runInstallScript(conn, detectedPlatform, installOptions, detectedShell, vscodeServerConfig, scriptId, logger, extensionPath);
        }
    }

    return parseInstallOutput(commandOutput, logger, scriptId, envVariables);
}

async function runInstallScript(
    conn: SSHConnection,
    platform: string,
    installOptions: ServerInstallOptions,
    shell: string,
    vscodeServerConfig: IServerConfig,
    scriptId: string,
    logger: Log,
    extensionPath: string,
): Promise<{ stdout: string; stderr: string }> {
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);

        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        // eslint-disable-next-line no-useless-assignment
        let command = '';

        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        return await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);
        // Use base64 encoding to avoid shell quoting issues across different login shells (bash, csh, tcsh, fish).
        // csh cannot handle multi-line strings inside single quotes with -c, so piping via base64 is the most portable approach.
        const base64Script = Buffer.from(installServerScript).toString('base64');
        return await conn.exec(`echo ${base64Script} | base64 -d | bash -l`);
    }
}

function parseInstallOutput(
    commandOutput: { stdout: string; stderr: string },
    logger: Log,
    scriptId: string,
    envVariables: string[]
): ServerInstallResult {
    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

async function getRemoteServerDir(
    conn: SSHConnection,
    detectedPlatform: string,
    customInstallPath: string | undefined,
    vscodeServerConfig: IServerConfig
): Promise<string> {
    if (detectedPlatform === 'windows') {
        const homeResult = await conn.exec('powershell -NoProfile -Command "Write-Output $env:USERPROFILE"');
        const home = homeResult.stdout.trim();
        const serverDataDir = customInstallPath
            ? customInstallPath.replace(/^~(?=[\\/]|$)/, home)
            : `${home}\\${vscodeServerConfig.serverDataFolderName}`;
        return `${serverDataDir}\\bin\\${vscodeServerConfig.commit}\\vscode-server.tar.gz`;
    } else {
        const homeResult = await conn.exec('echo $HOME');
        const home = homeResult.stdout.trim();
        const serverDataDir = customInstallPath
            ? customInstallPath.replace(/^~(?=\/|$)/, home)
            : `${home}/${vscodeServerConfig.serverDataFolderName}`;
        return `${serverDataDir}/bin/${vscodeServerConfig.commit}/vscode-server.tar.gz`;
    }
}

async function downloadAndUploadServerBinary(
    conn: SSHConnection,
    serverDownloadUrlTemplate: string,
    vscodeServerConfig: IServerConfig,
    bestRelease: IRelease,
    detectedPlatform: string,
    remoteArch: string,
    customInstallPath: string | undefined,
    logger: Log
): Promise<void> {
    const downloadUrl = buildServerDownloadUrl(
        serverDownloadUrlTemplate,
        vscodeServerConfig.quality,
        bestRelease.version,
        vscodeServerConfig.commit,
        detectedPlatform,
        remoteArch,
        bestRelease.build
    );

    const localPath = await downloadServerLocally(downloadUrl, vscodeServerConfig.commit, logger);
    try {
        const remotePath = await getRemoteServerDir(conn, detectedPlatform, customInstallPath, vscodeServerConfig);
        await conn.exec(detectedPlatform === 'windows'
            ? `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path (Split-Path -Parent '${remotePath}')"`
            : `mkdir -p "$(dirname '${remotePath}')"`);
        await uploadServerBinary(conn, localPath, remotePath, logger);
    } finally {
        try {
            await fs.promises.unlink(localPath);
            logger.trace(`Cleaned up local server binary: ${localPath}`);
        } catch (err) {
            logger.trace(`Failed to clean up local server binary: ${err}`);
        }
    }
}


function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation, serverPlatform, serverArch }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=\/|$)/, '$HOME')
        : `$HOME/${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `  echo "${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.sh', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL_TEMPLATE: serverDownloadUrlTemplate.replace(/\$\{/g, '\\${'),
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? 'true' : 'false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
        SERVER_PLATFORM: serverPlatform,
        SERVER_ARCH: serverArch,
    }, extensionPath);
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=[\\/]|$)/, '$(Resolve-Path ~)')
        : `$(Resolve-Path ~)\\${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `    "$${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.ps1', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir=""$SERVER_DATA_DIR""' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL: downloadUrl,
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? '$true' : '$false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}
