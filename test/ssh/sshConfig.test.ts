import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import { afterEach, describe, expect, it } from 'vitest';
import { configOverrides } from '../mocks/vscode';
import SSHConfiguration from '../../src/ssh/sshConfig';

// Characterisation tests for SSHConfiguration, built directly from a parsed
// SSHConfig (bypassing loadFromFS's filesystem/glob I/O, which needs its own
// integration coverage). Exercises: per-host lookup, "Host" pattern matching
// (including wildcard precedence, which ssh-config's own `compute()` resolves
// per OpenSSH rules — first-seen value wins), and the configured-hosts listing
// that filters out patterns.
describe('SSHConfiguration#getHostConfiguration', () => {
    it('returns directive values for an exact Host match', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    HostName foo.example.com\n    User bob\n    Port 2222\n'
        ));
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('foo.example.com');
        expect(hostConfig['User']).toBe('bob');
        expect(hostConfig['Port']).toBe('2222');
    });

    it('returns an empty configuration for a host with no matching section', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    HostName foo.example.com\n'));
        const hostConfig = config.getHostConfiguration('bar');
        expect(hostConfig['HostName']).toBeUndefined();
    });

    it('a wildcard Host contributes to any matching hostname', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host *\n    User globaluser\n'));
        expect(config.getHostConfiguration('anything.example.com')['User']).toBe('globaluser');
    });

    it('an earlier, more specific Host block wins over a later wildcard for the same key', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    User specific\n\nHost *\n    User globaluser\n'
        ));
        expect(config.getHostConfiguration('foo')['User']).toBe('specific');
    });

    it('a later wildcard fills in a key the earlier specific block did not set', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    User specific\n\nHost *\n    Port 2200\n'
        ));
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['User']).toBe('specific');
        expect(hostConfig['Port']).toBe('2200');
    });

    // Directive-name normalization (lowercase source -> canonical casing, e.g.
    // "hostname" -> "HostName") happens in `normalizeSSHConfig`, a private helper
    // only wired up on the `loadFromFS` path — constructing SSHConfiguration
    // directly from `SSHConfig.parse()` (as above) bypasses it entirely and
    // `compute()` then returns whatever casing the source used. See the
    // `SSHConfiguration.loadFromFS` describe block below for that behaviour.
});

describe('SSHConfiguration.loadFromFS', () => {
    let tmpDir: string;

    afterEach(async () => {
        configOverrides.clear();
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    async function loadFromContent(content: string): Promise<SSHConfiguration> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, content);
        configOverrides.set('remote.SSH.configFile', configPath);
        return SSHConfiguration.loadFromFS();
    }

    it('normalizes lowercase directive names to their canonical casing', async () => {
        const config = await loadFromContent('host foo\n    hostname foo.example.com\n    proxyjump bastion\n');
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('foo.example.com');
        expect(hostConfig['ProxyJump']).toBe('bastion');
    });

    it('inlines an Include directive\'s matched files in place', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includedPath = path.join(tmpDir, 'included.conf');
        await fs.promises.writeFile(includedPath, 'Host included-host\n    HostName included.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${includedPath}\nHost foo\n    HostName foo.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('included-host')['HostName']).toBe('included.example.com');
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
    });

    // The system config is pinned to a missing file: with the default, loadFromFS also reads
    // the host's /etc/ssh/ssh_config, and the GitHub runner's lists hosts of its own
    // (`.host`, `machine/.host`, 2026-11-07), so this assertion depended on the machine.
    it('returns an empty configuration when the configured file does not exist', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        configOverrides.set('remote.SSH.configFile', path.join(tmpDir, 'does-not-exist'));

        const config = await SSHConfiguration.loadFromFS(path.join(tmpDir, 'no-system-config'));
        expect(config.getAllConfiguredHosts()).toEqual([]);
    });

    it('appends the system config after the user config, resolving its relative Include against its own directory', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const userPath = path.join(tmpDir, 'user-config');
        await fs.promises.writeFile(userPath, 'Host user-host\n    HostName user.example.com\n');
        const systemDir = path.join(tmpDir, 'etc-ssh');
        await fs.promises.mkdir(path.join(systemDir, 'ssh_config.d'), { recursive: true });
        await fs.promises.writeFile(path.join(systemDir, 'ssh_config.d', 'a.conf'), 'Host system-host\n    HostName system.example.com\n');
        await fs.promises.writeFile(path.join(systemDir, 'ssh_config'), 'Include ssh_config.d/*.conf\n');
        configOverrides.set('remote.SSH.configFile', userPath);

        const config = await SSHConfiguration.loadFromFS(path.join(systemDir, 'ssh_config'));
        expect(config.getAllConfiguredHosts()).toEqual(['user-host', 'system-host']);
        expect(config.getHostConfiguration('system-host')['HostName']).toBe('system.example.com');
    });

    // A self-including or mutually-including config previously recursed forever
    // (each Include re-parsed and re-expanded the same file endlessly), hanging
    // the resolver. Both must terminate and still yield the directives that were
    // reachable before the cycle was cut off.
    it('terminates and still resolves when a config includes itself', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${configPath}\nHost foo\n    HostName foo.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
    });

    it('terminates and still resolves when two configs mutually include each other', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        const otherPath = path.join(tmpDir, 'other.conf');
        await fs.promises.writeFile(configPath, `Include ${otherPath}\nHost foo\n    HostName foo.example.com\n`);
        await fs.promises.writeFile(otherPath, `Include ${configPath}\nHost bar\n    HostName bar.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
        expect(config.getHostConfiguration('bar')['HostName']).toBe('bar.example.com');
    });

    it('expands a comma-separated Include value as multiple independent patterns, not one literal path', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const first = path.join(tmpDir, 'first.conf');
        const second = path.join(tmpDir, 'second.conf');
        await fs.promises.writeFile(first, 'Host first-host\n    HostName first.example.com\n');
        await fs.promises.writeFile(second, 'Host second-host\n    HostName second.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${first}, ${second}\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('first-host')['HostName']).toBe('first.example.com');
        expect(config.getHostConfiguration('second-host')['HostName']).toBe('second.example.com');
    });

    it('resolves each comma-separated Include entry as its own glob, matching multiple files per entry', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includeDir = path.join(tmpDir, 'config.d');
        await fs.promises.mkdir(includeDir, { recursive: true });
        await fs.promises.writeFile(path.join(includeDir, 'a.conf'), 'Host glob-a\n    HostName a.example.com\n');
        await fs.promises.writeFile(path.join(includeDir, 'b.conf'), 'Host glob-b\n    HostName b.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        // Absolute glob pattern (not a bare relative one) so it's independent of
        // the Include-resolution cwd quirk (glob always resolves relative to
        // ~/.ssh regardless of which config file is being parsed).
        await fs.promises.writeFile(configPath, `Include ${path.join(includeDir, '*.conf')}\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('glob-a')['HostName']).toBe('a.example.com');
        expect(config.getHostConfiguration('glob-b')['HostName']).toBe('b.example.com');
    });

    it('normalizes a multi-value IdentityFile line to a string[] instead of a single string', async () => {
        const config = await loadFromContent(
            'Host foo\n    IdentityFile ~/.ssh/id_rsa\n    IdentityFile ~/.ssh/id_ed25519\n'
        );
        const hostConfig = config.getHostConfiguration('foo');
        expect(Array.isArray(hostConfig['IdentityFile'])).toBe(true);
        expect(hostConfig['IdentityFile']).toHaveLength(2);
    });

    it('still returns a single IdentityFile line as a 1-element array (ssh-config always arrays this directive)', async () => {
        const config = await loadFromContent('Host foo\n    IdentityFile ~/.ssh/id_rsa\n');
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['IdentityFile']).toEqual(['~/.ssh/id_rsa']);
    });

    // `Match` opens a nested block exactly like `Host` does, and ssh-config's
    // `compute()` copies each sub-directive's `param` through verbatim — so a
    // block we fail to normalize surfaces as `hostname`/`user`/`port` and every
    // caller reading `sshHostConfig['HostName']` silently sees `undefined`
    // (connect to the literal alias, as the local user, on port 22). The bug was
    // casing-dependent — spelling the same block `HostName`/`User`/`Port` worked
    // — which is exactly the kind of silent inconsistency a test must pin down.
    it('normalizes lowercase directive names inside a Match block', async () => {
        const config = await loadFromContent('Match host build*\n    hostname 10.0.0.5\n    user builder\n    port 2222\n');
        const hostConfig = config.getHostConfiguration('build01');
        expect(hostConfig['HostName']).toBe('10.0.0.5');
        expect(hostConfig['User']).toBe('builder');
        expect(hostConfig['Port']).toBe('2222');
    });

    it('applies an Include directive nested inside a Match block', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includedPath = path.join(tmpDir, 'included.conf');
        await fs.promises.writeFile(includedPath, 'HostName included.example.com\n    User included-user\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Match host build*\n    Include ${includedPath}\n    Port 2222\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        const hostConfig = config.getHostConfiguration('build01');
        expect(hostConfig['HostName']).toBe('included.example.com');
        expect(hostConfig['User']).toBe('included-user');
        expect(hostConfig['Port']).toBe('2222');
    });

    // OpenSSH documents Include as taking *whitespace*-separated pathnames;
    // ssh-config hands the whole list over as one string, so splitting on ','
    // alone globbed `a.conf b.conf` as a single literal pattern that matched
    // nothing — every host in both files vanished with no error at all.
    it('expands a whitespace-separated Include value as multiple independent patterns', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includeDir = path.join(tmpDir, 'conf.d');
        await fs.promises.mkdir(includeDir, { recursive: true });
        await fs.promises.writeFile(path.join(includeDir, 'a.conf'), 'Host ws-glob\n    HostName ws-glob.example.com\n');
        const other = path.join(tmpDir, 'other.conf');
        await fs.promises.writeFile(other, 'Host ws-other\n    HostName ws-other.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${path.join(includeDir, '*.conf')} ${other}\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('ws-glob')['HostName']).toBe('ws-glob.example.com');
        expect(config.getHostConfiguration('ws-other')['HostName']).toBe('ws-other.example.com');
    });

    // The flip side of splitting on whitespace: a quoted pathname that contains
    // spaces must NOT be torn apart. ssh-config strips the quote characters
    // before we see the value and only leaves a per-line `quoted` flag, so this
    // is the one quoting case we can still honour.
    it('keeps a quoted Include path containing spaces intact', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includeDir = path.join(tmpDir, 'quoted dir');
        await fs.promises.mkdir(includeDir, { recursive: true });
        const includedPath = path.join(includeDir, 'a.conf');
        await fs.promises.writeFile(includedPath, 'Host quoted-host\n    HostName quoted.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include "${includedPath}"\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('quoted-host')['HostName']).toBe('quoted.example.com');
    });

    it('applies an Include directive nested inside a Host block', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includedPath = path.join(tmpDir, 'included.conf');
        await fs.promises.writeFile(includedPath, 'HostName included.example.com\n    User included-user\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Host foo\n    Include ${includedPath}\n    Port 2222\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('included.example.com');
        expect(hostConfig['User']).toBe('included-user');
        expect(hostConfig['Port']).toBe('2222');
    });
});

describe('SSHConfiguration#getAllConfiguredHosts', () => {
    it('lists concrete Host entries', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    HostName foo.example.com\n\nHost bar\n    HostName bar.example.com\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['foo', 'bar']);
    });

    it('excludes wildcard/pattern and negated Host entries', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    HostName foo.example.com\n\nHost *\n    User globaluser\n\nHost !excluded\n    HostName excluded.example.com\n'
        ));
        expect(config.getAllConfiguredHosts()).toEqual(['foo']);
    });

    it('deduplicates a Host name that appears in more than one section', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    User a\n\nHost foo\n    Port 22\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['foo']);
    });

    it('lists every name in a multi-value "Host dev staging" line, not just the first', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host dev staging\n    User shared\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['dev', 'staging']);
    });

    it('filters pattern names out of a multi-value Host line while keeping concrete ones', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host dev *.internal !excluded\n    User shared\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['dev']);
    });
});
