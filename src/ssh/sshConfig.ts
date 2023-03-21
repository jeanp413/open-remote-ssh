import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig, { Directive, Line, Section } from 'ssh-config';
import * as vscode from 'vscode';
import { exists as fileExists, normalizeToSlash, untildify } from '../common/files';
import { isWindows } from '../common/platform';
import { glob } from 'glob';

const systemSSHConfig = isWindows ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh\\ssh_config') : '/etc/ssh/ssh_config';
const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh/config');

export function getSSHConfigPath() {
    const sshConfigPath = vscode.workspace.getConfiguration('remote.SSH').get<string>('configFile');
    return sshConfigPath ? untildify(sshConfigPath) : defaultSSHConfigPath;
}

function isDirective(line: Line): line is Directive {
    return line.type === SSHConfig.DIRECTIVE;
}

function isHostSection(line: Line): line is Section {
    return isDirective(line) && line.param === 'Host' && !!line.value && !!(line as Section).config;
}

function isIncludeDirective(line: Line): line is Section {
    return isDirective(line) && line.param === 'Include' && !!line.value;
}

const SSH_CONFIG_PROPERTIES: Record<string, string> = {
    'host': 'Host',
    'hostname': 'HostName',
    'user': 'User',
    'port': 'Port',
    'identityagent': 'IdentityAgent',
    'identitiesonly': 'IdentitiesOnly',
    'identityfile': 'IdentityFile',
    'forwardagent': 'ForwardAgent',
    'proxyjump': 'ProxyJump',
    'proxycommand': 'ProxyCommand',
    'include': 'Include',
};

function normalizeProp(prop: Directive) {
    prop.param = SSH_CONFIG_PROPERTIES[prop.param.toLowerCase()] || prop.param;
}

function normalizeSSHConfig(config: SSHConfig) {
    for (const line of config) {
        if (isDirective(line)) {
            normalizeProp(line);
        }
        if (isHostSection(line)) {
            normalizeSSHConfig(line.config);
        }
    }
    return config;
}

async function parseSSHConfigFromFile(filePath: string, userConfig: boolean) {
    let content = '';
    if (await fileExists(filePath)) {
        content = (await fs.promises.readFile(filePath, 'utf8')).trim();
    }
    const config = normalizeSSHConfig(SSHConfig.parse(content));

    const includedConfigs = new Map<number, SSHConfig>();
    for (let i = 0; i < config.length; i++) {
        const line = config[i];
        if (isIncludeDirective(line)) {
            const includePaths = await glob(normalizeToSlash(untildify(line.value)), {
                absolute: true,
                cwd: normalizeToSlash(path.dirname(userConfig ? defaultSSHConfigPath : systemSSHConfig))
            });
            for (const p of includePaths) {
                includedConfigs.set(i, await parseSSHConfigFromFile(p, userConfig));
            }
        }
    }
    for (const [idx, includeConfig] of includedConfigs.entries()) {
        config.splice(idx, 1, ...includeConfig);
    }

    return config;
}

export default class SSHConfiguration {

    static async loadFromFS(): Promise<SSHConfiguration> {
        const config = await parseSSHConfigFromFile(getSSHConfigPath(), true);
        config.push(...await parseSSHConfigFromFile(systemSSHConfig, false));

        return new SSHConfiguration(config);
    }

    constructor(private sshConfig: SSHConfig) {
    }

    getAllConfiguredHosts(): string[] {
        const hosts = new Set<string>();
        for (const line of this.sshConfig) {
            if (isHostSection(line)) {
                const value = Array.isArray(line.value as string[] | string) ? line.value[0] : line.value;
                const isPattern = /^!/.test(value) || /[?*]/.test(value);
                if (!isPattern) {
                    hosts.add(value);
                }
            }
        }

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): Record<string, string> {
        return this.sshConfig.compute(host);
    }
}
