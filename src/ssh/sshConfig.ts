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

// `Host` *and* `Match` open a nested block, and anything that walks the tree
// (name normalization, Include expansion) must descend into both. Keyed on the
// presence of `config` rather than on `param` because `Match` sections are the
// case we kept missing: ssh-config copies a sub-directive's `param` through
// `compute()` verbatim, so a `Match` block we skipped surfaced as lowercase
// `hostname`/`user`/`port` and every caller reading `HostName` saw `undefined`.
function isNestedSection(line: Line): line is Section {
    return isDirective(line) && !!(line as Section).config;
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
        if (isNestedSection(line)) {
            normalizeSSHConfig(line.config);
        }
    }
    return config;
}

// OpenSSH caps nested Include expansion at 16 levels (sshd's `includedepth`)
// and errors out beyond that; we mirror the cap but degrade gracefully
// (stop expanding further) rather than throwing, since a malformed/cyclic
// config shouldn't take down the whole extension.
const MAX_INCLUDE_DEPTH = 16;

// Walks `config` looking for Include directives to expand in place, and
// recurses into Host/Match sections so a host-scoped Include (inside a
// `Host foo { Include ... }` block) is honoured too, not just top-level ones.
// `includeDir` is where a relative Include resolves: OpenSSH reads it against ~/.ssh for the
// user config and against the system config's own directory for the system config.
async function resolveIncludes(config: SSHConfig, includeDir: string, visited: Set<string>): Promise<void> {
    const includedConfigs: [number, SSHConfig[]][] = [];
    for (let i = 0; i < config.length; i++) {
        const line = config[i];
        if (isIncludeDirective(line)) {
            // OpenSSH's Include takes *whitespace*-separated pathnames, and
            // ssh-config doesn't array-split this directive — so `Include a b`
            // arrives as one string and splitting on ',' alone globbed it as
            // the single literal pattern "a b", which matched nothing and made
            // every host in both files disappear without any error. Commas stay
            // accepted: they were the only separator we used to honour.
            // A quoted value is left whole, because that's the only way a
            // pathname containing spaces can still be expressed — ssh-config
            // strips the quote characters before we see the value and leaves
            // just a per-line `quoted` flag, so a *mixed* quoted/unquoted list
            // is unrecoverable (it stays broken, exactly as it is today).
            const rawValue = line.value as string;
            const values = (line.quoted ? [rawValue] : rawValue.split(/[\s,]+/)).map(s => s.trim()).filter(s => !!s);
            const configs: SSHConfig[] = [];
            for (const value of values) {
                const includePaths = await glob(normalizeToSlash(untildify(value)), {
                    absolute: true,
                    cwd: normalizeToSlash(includeDir)
                });
                for (const p of includePaths) {
                    configs.push(await parseSSHConfigFromFile(p, includeDir, visited));
                }
            }
            includedConfigs.push([i, configs]);
        } else if (isNestedSection(line)) {
            await resolveIncludes(line.config, includeDir, visited);
        }
    }
    for (const [idx, includeConfigs] of includedConfigs.reverse()) {
        config.splice(idx, 1, ...includeConfigs.flat());
    }
}

async function parseSSHConfigFromFile(filePath: string, includeDir: string, visited: Set<string> = new Set()): Promise<SSHConfig> {
    // Guard against Include cycles (self-include, mutual A<->B include) and
    // runaway include chains, both of which would otherwise hang the
    // resolver by recursing forever. `visited` tracks the ancestor chain for
    // this branch only, so a diamond-shaped Include (two branches pulling in
    // the same, non-cyclic file) is still expanded normally.
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath) || visited.size >= MAX_INCLUDE_DEPTH) {
        return SSHConfig.parse('');
    }

    let content = '';
    if (await fileExists(filePath)) {
        content = (await fs.promises.readFile(filePath, 'utf8')).trim();
    }
    const config = normalizeSSHConfig(SSHConfig.parse(content));

    const nestedVisited = new Set(visited);
    nestedVisited.add(resolvedPath);
    await resolveIncludes(config, includeDir, nestedVisited);

    return config;
}

export default class SSHConfiguration {

    // The system config is a parameter so a caller (a test) can pin it: the default reads the
    // host's real /etc/ssh/ssh_config, whose hosts differ machine to machine.
    static async loadFromFS(systemConfigPath: string = systemSSHConfig): Promise<SSHConfiguration> {
        const config = await parseSSHConfigFromFile(getSSHConfigPath(), path.dirname(defaultSSHConfigPath));
        config.push(...await parseSSHConfigFromFile(systemConfigPath, path.dirname(systemConfigPath)));

        return new SSHConfiguration(config);
    }

    constructor(private sshConfig: SSHConfig) {
    }

    getAllConfiguredHosts(): string[] {
        const hosts = new Set<string>();
        for (const line of this.sshConfig) {
            if (isHostSection(line)) {
                // `Host` accepts a space-separated list of patterns (e.g. `Host dev staging`);
                // every name in the list is a distinct host, not just the first one.
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
