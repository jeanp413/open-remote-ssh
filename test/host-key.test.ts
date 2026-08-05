import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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

const KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');

const containerName = `open-remote-ssh-test-${randomUUID()}`;

let hostPort: number;
let activeResolver: InstanceType<typeof RemoteSSHResolver> | undefined;

function resolveTestHost() {
  vscode.window.setPassword(PASSWORD);

  const logger = new Log('Remote - SSH');
  const extContext = new vscode.ExtensionContext();
  const resolver = new RemoteSSHResolver(extContext, logger);
  activeResolver = resolver;
  const remoteContext = new vscode.RemoteAuthorityResolverContext();
  return resolver.resolve(getRemoteAuthority('test'), remoteContext);
}

afterEach(() => {
  // Each resolve opens tunnels on local ports; free them before the next one
  activeResolver?.dispose();
  activeResolver = undefined;
});

beforeAll(async () => {
  vol.reset();

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

  hostPort = getMappedPort(containerName);

  await waitForSSHReady(USERNAME, PASSWORD, hostPort, 60_000);

  vol.fromJSON({
    '/etc/ssh/ssh_config': [
      'Host test',
      '  HostName 127.0.0.1',
      `  Port ${hostPort}`,
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
    ].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });
}, 120_000);

afterAll(() => {
  vscode.workspace.resetConfig();
  runDocker(['rm', '-f', containerName], true);
});

it('records the host key on first connect', async () => {
  expect(vol.existsSync(KNOWN_HOSTS)).toBe(false);

  const result = await resolveTestHost();
  expect(result.host).to.eql('127.0.0.1');

  const content = vol.readFileSync(KNOWN_HOSTS, 'utf8') as string;
  const lines = content.trim().split('\n');
  expect(lines).toHaveLength(1);

  const [name, keyType, keyBase64] = lines[0].split(' ');
  expect(name).to.eql(`[127.0.0.1]:${hostPort}`);
  expect(keyType).toMatch(/^(ssh|ecdsa)-/);
  expect(() => Buffer.from(keyBase64, 'base64')).not.toThrow();
}, 120_000);

it('connects silently when the key matches', async () => {
  const before = vol.readFileSync(KNOWN_HOSTS, 'utf8') as string;

  const result = await resolveTestHost();
  expect(result.host).to.eql('127.0.0.1');

  // Nothing prompted, nothing rewritten
  expect(vol.readFileSync(KNOWN_HOSTS, 'utf8')).to.eql(before);
}, 60_000);

it('refuses to connect when the recorded key differs and verifyKnownHosts is reject', async () => {
  const content = vol.readFileSync(KNOWN_HOSTS, 'utf8') as string;
  const [name, keyType] = content.trim().split(' ');

  // Forge a same-type key that cannot match the server's
  const typeBuffer = Buffer.from(keyType);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(typeBuffer.length, 0);
  const forged = Buffer.concat([length, typeBuffer, Buffer.alloc(32, 0x42)]).toString('base64');
  vol.writeFileSync(KNOWN_HOSTS, `${name} ${keyType} ${forged}\n`);

  vscode.workspace.setConfig('verifyKnownHosts', 'reject');

  await expect(resolveTestHost()).rejects.toThrow();

  // The forged entry is left untouched
  expect((vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim().split(' ')[2]).to.eql(forged);
}, 60_000);

it('cancelling the changed-key prompt refuses the connection', async () => {
  vscode.workspace.setConfig('verifyKnownHosts', 'ask');
  vscode.window.setWarningAnswer(undefined);

  await expect(resolveTestHost()).rejects.toThrow();
}, 60_000);

it('accepting the changed-key prompt updates the entry and connects', async () => {
  vscode.workspace.setConfig('verifyKnownHosts', 'ask');
  vscode.window.setWarningAnswer('Update and Connect');

  const result = await resolveTestHost();
  expect(result.host).to.eql('127.0.0.1');

  // The forged key was replaced by the server's real one
  const [, , keyBase64] = (vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim().split(' ');
  expect(Buffer.from(keyBase64, 'base64').subarray(4 + 11).equals(Buffer.alloc(32, 0x42))).toBe(false);

  vscode.window.setWarningAnswer(undefined);
}, 60_000);
