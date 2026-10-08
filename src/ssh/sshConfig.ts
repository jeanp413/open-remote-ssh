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

async function resolveInclude(line: Section, userConfig: boolean): Promise<SSHConfig[]> {
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
    return configs;
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
            includedConfigs.push([i, await resolveInclude(line, userConfig)]);
        } else if (isHostSection(line)) {
            // ssh config has no block terminator, so an `Include` written after a
            // `Host` block is parsed as a child of that block. ssh reads the file
            // linearly, so any `Host` the included file declares ends the enclosing
            // block — the included lines belong next to it, not inside it.
            const hoisted: SSHConfig[] = [];
            for (let j = line.config.length - 1; j >= 0; j--) {
                const child = line.config[j];
                if (isIncludeDirective(child)) {
                    hoisted.unshift(...await resolveInclude(child, userConfig));
                    line.config.splice(j, 1);
                }
            }
            if (hoisted.length) {
                includedConfigs.push([i + 1, hoisted]);
            }
        }
    }
    for (const [idx, includeConfigs] of includedConfigs.reverse()) {
        // A hoisted include is inserted after its section, everything else
        // replaces the `Include` directive it came from.
        const deleteCount = idx < config.length && isIncludeDirective(config[idx]) ? 1 : 0;
        config.splice(idx, deleteCount, ...includeConfigs.flat());
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
                // A single `Host` line can declare several names, all of which
                // share the block's configuration.
                const values = Array.isArray(line.value) ? line.value.map(v => v.val) : [line.value];
                for (const value of values) {
                    const isPattern = /^!/.test(value) || /[?*]/.test(value);
                    if (!isPattern) {
                        hosts.add(value);
                    }
                }
            }
        }

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): HostConfiguration {
        return this.sshConfig.compute(host) as HostConfiguration;
    }
}
