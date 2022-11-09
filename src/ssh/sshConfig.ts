import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig, { Directive, Line, Section } from 'ssh-config';
import * as vscode from 'vscode';
import { exists as fileExists } from '../common/files';
import { isWindows } from '../common/platform';

const systemSSHConfig = isWindows ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh\\ssh_config') : '/etc/ssh/ssh_config';
const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh/config');

export function getSSHConfigPath() {
    const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
    return remoteSSHconfig.get<string>('configFile') || defaultSSHConfigPath;
}

function isDirective(line: Line): line is Directive {
    return line.type === SSHConfig.DIRECTIVE
}

function isHostSection(line: Line): line is Section {
    return line.type === SSHConfig.DIRECTIVE && line.param === 'Host' && !!line.value && !!(line as Section).config;
}

const SSH_CONFIG_PROPERTIES = new Map([
    ['host', 'Host'],
    ['hostname', 'HostName'],
    ['user', 'User'],
    ['port', 'Port'],
    ['identityagent', 'IdentityAgent'],
    ['identitiesonly', 'IdentitiesOnly'],
    ['identityfile', 'IdentityFile'],
    ['forwardagent', 'ForwardAgent'],
    ['proxyjump', 'ProxyJump'],
    ['proxycommand', 'ProxyCommand'],
]);

function normalizeProp(prop: Directive) {
    prop.param = SSH_CONFIG_PROPERTIES.get(prop.param.toLowerCase()) || prop.param;
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
}

export default class SSHConfiguration {

    static async loadFromFS(): Promise<SSHConfiguration> {
        const sshConfigPath = getSSHConfigPath();
        let content = '';
        if (await fileExists(sshConfigPath)) {
            content = (await fs.promises.readFile(sshConfigPath, 'utf8')).trim();
        }
        const config = SSHConfig.parse(content);

        if (await fileExists(systemSSHConfig)) {
            content = (await fs.promises.readFile(systemSSHConfig, 'utf8')).trim();
            config.push(...SSHConfig.parse(content));
        }

        return new SSHConfiguration(config);
    }

    constructor(private sshConfig: SSHConfig) {
        // Normalize config property names
        normalizeSSHConfig(sshConfig);
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
