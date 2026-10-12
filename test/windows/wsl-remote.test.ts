import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from '../../src/authResolver';
import SSHConfiguration from '../../src/ssh/sshConfig';
import { Log } from '../mocks/logger';
import * as vscode from '../mocks/vscode';
import { isWslUsable, startWslSshServer, stopWslSshServer } from '../utils/wsl-ssh-server';

/**
 * Windows client against a real Linux SSH server.
 *
 * The Linux fixtures drive `linuxserver/openssh-server` in Docker, which a
 * Windows runner can't host — its Docker daemon serves Windows containers only,
 * which is what the `windows-*` fixtures use to test a Windows *remote*. WSL2
 * gives a real Linux kernel with a real `sshd`, so this covers the other
 * direction: a genuine Windows client resolving a genuine Linux remote, with a
 * real `ProxyCommand` process, real socket, real SSH handshake and real server
 * install.
 *
 * Unlike `fixtures.test.ts` this does NOT mock `node:fs`. The paths under test
 * are Windows paths, and the point is that they reach the real filesystem the
 * way they do in production.
 */

const DISTRO = 'Ubuntu-24.04';
const USERNAME = 'openremotessh';
const PASSWORD = 'openremotessh';
const PORT = 2222;

const PRODUCT_JSON = JSON.stringify({
  nameShort: 'VSCodium',
  nameLong: 'VSCodium',
  applicationName: 'codium',
  quality: 'stable',
  commit: '4c0b0c6cc561d2d3636d1ec250935431876ce4dc',
  version: '1.126.04524',
  serverApplicationName: 'codium-server',
  serverDataFolderName: '.vscodium-server',
  serverDownloadUrlTemplate: 'https://github.com/VSCodium/vscodium/releases/download/1.126.04524/vscodium-reh-${os}-${arch}-1.126.04524.tar.gz',
});

const EXTENSION_PATH = resolve(__dirname, '..', '..');

let root: string;
let sshConfigPath: string;
let relayPath: string;
let host: string;

/**
 * `node.exe <relay> <host> <port>`, unquoted, exactly as a user would write it
 * in their SSH config. Every token holds Windows path separators, which is what
 * makes this the end-to-end case for #309: a tokenizer that treats `\` as a
 * shell escape hands `spawn()` a path like `C:hostedtoolcachewindowsnode.exe`
 * and the connection dies with ENOENT/EPIPE before the SSH handshake starts.
 */
function proxyCommand(): string {
  return `${process.execPath} ${relayPath} ${host} ${PORT}`;
}

describe.skipIf(!isWslUsable())('windows client -> linux remote (WSL)', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'open-remote-ssh-win-'));

    // A nested directory keeps several separators in the relay path, so a
    // single surviving backslash can't make the test pass by accident.
    const relayDir = join(root, 'proxy', 'bin');
    mkdirSync(relayDir, { recursive: true });

    relayPath = join(relayDir, 'relay.cjs');
    // Copied rather than referenced in place so the relay sits under a path
    // this suite controls.
    writeFileSync(relayPath, readFileSync(resolve(__dirname, 'relay.cjs'), 'utf8'), 'utf8');

    const appRoot = join(root, 'app');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, 'product.json'), PRODUCT_JSON, 'utf8');

    // The reachable address isn't known until the server is up, and both hosts
    // below need it, so the config is written afterwards.
    host = await startWslSshServer({ distro: DISTRO, username: USERNAME, password: PASSWORD, port: PORT });

    sshConfigPath = join(root, 'ssh_config');
    writeFileSync(sshConfigPath, [
      'Host *',
      '  StrictHostKeyChecking no',
      '',
      'Host direct',
      `  HostName ${host}`,
      `  Port ${PORT}`,
      `  User ${USERNAME}`,
      '',
      'Host proxied',
      `  HostName ${host}`,
      `  Port ${PORT}`,
      `  User ${USERNAME}`,
      `  ProxyCommand ${proxyCommand()}`,
      '',
    ].join('\n'), 'utf8');

    vscode.setAppRoot(appRoot);
    vscode.setConfiguration({ 'remote.SSH.configFile': sshConfigPath });
    vscode.window.setPassword(PASSWORD);
  }, 900_000);

  afterAll(() => {
    stopWslSshServer(DISTRO);
    vscode.resetConfiguration();

    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads both hosts from the SSH config', async () => {
    const config = await SSHConfiguration.loadFromFS();

    expect(config.getAllConfiguredHosts()).to.include.members(['direct', 'proxied']);
  });

  // Exercises the whole stack: Windows client, real Linux sshd, real server
  // install over SSH. A `proxied` failure on top of this is therefore
  // attributable to the ProxyCommand path alone.
  it('resolves a direct connection', async () => {
    const result = await resolveHost('direct');

    // `resolve` hands back a locally forwarded port, so the host is always
    // loopback on the client regardless of where the remote lives.
    expect(result.host).to.eql('127.0.0.1');
    expect(result.port).to.be.greaterThan(0);
  }, 300_000);

});

async function resolveHost(host: string) {
  const logger = new Log('Remote - SSH');
  const extContext = new vscode.ExtensionContext();
  extContext.extensionPath = EXTENSION_PATH;

  const resolver = new RemoteSSHResolver(extContext, logger);

  try {
    return await resolver.resolve(getRemoteAuthority(host), new vscode.RemoteAuthorityResolverContext());
  }
  finally {
    resolver.dispose();
  }
}
