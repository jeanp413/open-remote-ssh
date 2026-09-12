import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';

const SERVER_SETUP = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;

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

const IMAGE = 'local-ubuntu-bash';
const USERNAME = 'openremotessh';
const PASSWORD = 'openremotessh';

const containerName = `open-remote-ssh-test-${randomUUID()}`;
// The config lives on the real filesystem because the local ssh client reads
// it with a plain exec, and gets mirrored into memfs for the resolver, which
// runs against mocked fs.
const configPath = path.join(os.tmpdir(), `open-remote-ssh-test-config-${randomUUID()}`);
const identityKeyPath = path.join(os.tmpdir(), `open-remote-ssh-test-key-${randomUUID()}`);
const knownHostsPath = path.join(os.tmpdir(), `open-remote-ssh-test-known-hosts-${randomUUID()}`);

let hostPort: number;

function hostConfigLines(gssapi: boolean): string[] {
  return [
    'Host test',
    '  HostName 127.0.0.1',
    `  Port ${hostPort}`,
    `  User ${USERNAME}`,
    ...(gssapi ? ['  GSSAPIAuthentication yes'] : []),
    `  IdentityFile ${identityKeyPath}`,
    // Keep the client from burning sshd's MaxAuthTries on the developer's own
    // agent and default keys before reaching the fixture identity.
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    `  UserKnownHostsFile ${knownHostsPath}`,
  ];
}

beforeAll(async () => {
  vol.reset();
  vscode.clearConfiguration();

  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', identityKeyPath]);

  const publicKey = fs.readFileSync(`${identityKeyPath}.pub`, 'utf8').trim();

  runDocker(['rm', '-f', containerName], true);

  runDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    containerName,
    '--publish',
    '2222',
    '--env',
    `USER_NAME=${USERNAME}`,
    '--env',
    `USER_PASSWORD=${PASSWORD}`,
    '--env',
    'PASSWORD_ACCESS=true',
    '--env',
    'SUDO_ACCESS=false',
    '--env',
    'LOG_STDOUT=true',
    IMAGE,
  ]);

  // The fixture's PUBLIC_KEY env lands in /config/.ssh, which sshd does not
  // consult; install the key in the user's home instead so the local ssh
  // client can authenticate non-interactively.
  runDocker([
    'exec', containerName, 'sh', '-c',
    `mkdir -p /home/${USERNAME}/.ssh && echo '${publicKey}' > /home/${USERNAME}/.ssh/authorized_keys && chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}/.ssh && chmod 700 /home/${USERNAME}/.ssh && chmod 600 /home/${USERNAME}/.ssh/authorized_keys`,
  ]);

  hostPort = getMappedPort(containerName);

  await waitForSSHReady(USERNAME, PASSWORD, hostPort, 60_000);
}, 120_000);

afterAll(() => {
  runDocker(['rm', '-f', containerName], true);
  for (const file of [configPath, identityKeyPath, `${identityKeyPath}.pub`, knownHostsPath]) {
    fs.rmSync(file, { force: true });
  }
  vscode.clearConfiguration();
});

it('connects through the local ssh client when GSSAPI is requested', async () => {
  const config = hostConfigLines(true).join('\n');
  fs.writeFileSync(configPath, config);
  vol.fromJSON({
    [configPath]: config,
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });
  vscode.setConfiguration('remote.SSH.configFile', configPath);

  const logger = new Log('Remote - SSH');
  const extContext = new vscode.ExtensionContext();
  const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
  const remoteContext = new vscode.RemoteAuthorityResolverContext();
  const authority = getRemoteAuthority('test');
  const result = await remoteSSHResolver.resolve(authority, remoteContext);

  expect(result).toBeDefined();
  expect(result.host).to.eql('127.0.0.1');

  remoteSSHResolver.dispose();
}, 120_000);
