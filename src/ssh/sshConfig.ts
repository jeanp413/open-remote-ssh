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
            content = await fs.promises.readFile(sshConfigPath, 'utf8');
        }
        const config = SSHConfig.parse(content);

        if (await fileExists(systemSSHConfig)) {
            content = await fs.promises.readFile(systemSSHConfig, 'utf8');
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
                const values = Array.isArray(hostSection.value as string[] | string) ? hostSection.value : [hostSection.value];
                for (const v of values) {
                    // Ignore if the value is a pattern
                    if (!/^!/.test(v) && !/[?*]/.test(v)) {
                        hosts.add(v);
                    }
                }
            });

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): Record<string, string> {
        return this.sshConfig.compute(host);
    }
}
