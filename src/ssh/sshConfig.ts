import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig, { Directive, Line, Section } from 'ssh-config';
import * as vscode from 'vscode';
import { exists as fileExists, normalizeToSlash, untildify } from '../common/files';
import { isWindows } from '../common/platform';
import { glob } from 'glob';

// Only a few directives might return an array
// https://github.com/cyjake/ssh-config/blob/master/src/ssh-config.ts#L10
export type HostConfiguration = {
	CanonicalDomains?: string | string[];
	GlobalKnownHostsFile?: string | string[];
	Host?: string | string[];
	IPQoS?: string | string[];
	Match?: string | string[];
	ProxyCommand?: string | string[];
	SendEnv?: string | string[];
	UserKnownHostsFile?: string | string[];
} & Record<string, string>;

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
    'preferredauthentications': 'PreferredAuthentications',
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

    const includedConfigs: [number, SSHConfig[]][] = [];
    for (let i = 0; i < config.length; i++) {
        const line = config[i];
        if (isIncludeDirective(line)) {
            const values = (line.value as string).split(',').map(s => s.trim());
            const configs: SSHConfig[] = [];
            for (const value of values) {
                const includePaths = await glob(normalizeToSlash(untildify(value)), {
                    absolute: true,
                    cwd: normalizeToSlash(path.dirname(userConfig ? defaultSSHConfigPath : systemSSHConfig))
                });
                for (const p of includePaths) {
                    configs.push(await parseSSHConfigFromFile(p, userConfig));
                }
            }
            includedConfigs.push([i, configs]);
        }
    }
    for (const [idx, includeConfigs] of includedConfigs.reverse()) {
        config.splice(idx, 1, ...includeConfigs.flat());
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
                const value = Array.isArray(line.value) ? line.value[0].val : line.value;
                const isPattern = /^!/.test(value) || /[?*]/.test(value);
                if (!isPattern) {
                    hosts.add(value);
                }
            }
        }

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): HostConfiguration {
        return this.sshConfig.compute(host) as HostConfiguration;
    }
}
