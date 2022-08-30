import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig, { Line, Section } from 'ssh-config';
import * as vscode from 'vscode';
import { exists as fileExists } from '../common/files';
import { isWindows } from '../common/platform';

const systemSSHConfig = isWindows ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh\\ssh_config') : '/etc/ssh/ssh_config';
const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh/config');

export function getSSHConfigPath() {
    const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
    return remoteSSHconfig.get<string>('configFile') || defaultSSHConfigPath;
}

function isHostSection(line: Line): line is Section {
    return line.type === SSHConfig.DIRECTIVE && line.param === 'Host' && !!line.value && !!(line as Section).config;
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
    }

    getAllConfiguredHosts(): string[] {
        const hosts = new Set<string>();
        this.sshConfig
            .filter(isHostSection)
            .forEach(hostSection => {
                const value = Array.isArray(hostSection.value as string[] | string) ? hostSection.value[0] : hostSection.value;
                const hasHostName = hostSection.config.find(line => line.type === SSHConfig.DIRECTIVE && line.param === 'HostName' && !!line.value);
                const isPattern = /^!/.test(value) || /[?*]/.test(value);
                if (hasHostName && !isPattern) {
                    hosts.add(value);
                }
            });

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): Record<string, string> {
        return this.sshConfig.compute(host);
    }
}
