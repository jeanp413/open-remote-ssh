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
// The forged key written in the mismatch test, checked again after the update
let forgedBase64: string;

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
  vscode.window.showWarningMessage.mockClear();
  vscode.window.showErrorMessage.mockClear();
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
  forgedBase64 = Buffer.concat([length, typeBuffer, Buffer.alloc(32, 0x42)]).toString('base64');
  vol.writeFileSync(KNOWN_HOSTS, `${name} ${keyType} ${forgedBase64}\n`);

  vscode.workspace.setConfig('verifyKnownHosts', 'reject');

  await expect(resolveTestHost()).rejects.toThrow();

  // Refused outright: no prompt at all. Without this the test would pass
  // with the reject policy removed, since an unanswered prompt also refuses.
  expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

  // The forged entry is left untouched
  expect((vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim().split(' ')[2]).to.eql(forgedBase64);
}, 60_000);

it('cancelling the changed-key prompt refuses the connection', async () => {
  vscode.workspace.setConfig('verifyKnownHosts', 'ask');
  vscode.window.setWarningAnswer(undefined);

  await expect(resolveTestHost()).rejects.toThrow();

  expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
}, 60_000);

it('accepting the changed-key prompt updates the entry and connects', async () => {
  vscode.workspace.setConfig('verifyKnownHosts', 'ask');
  vscode.window.setWarningAnswer('Update and Connect');

  const result = await resolveTestHost();
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
  // No leftover conflict, so no error about one
  expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();

  // The forged key was replaced by the server's real one, in place
  const lines = (vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0].split(' ')[2]).not.to.eql(forgedBase64);

  vscode.window.setWarningAnswer(undefined);
}, 60_000);

it('refuses when a wildcard line would keep trusting the old key', async () => {
  // A wildcard line can't be edited safely, so approving the change would
  // leave both keys trusted — the extension refuses instead.
  // The recorded name keeps its [host]:port form — the connection is on a
  // non-default port, so a bare hostname wouldn't match at all
  const [name, keyType] = (vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim().split(' ');
  const sharedLine = `${name},*.nowhere.invalid ${keyType} ${forgedBase64}`;
  vol.writeFileSync(KNOWN_HOSTS, `${sharedLine}\n`);

  vscode.workspace.setConfig('verifyKnownHosts', 'ask');
  vscode.window.setWarningAnswer('Update and Connect');

  await expect(resolveTestHost()).rejects.toThrow();

  expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
  // Told the user which line still has to go
  expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce();
  expect(vscode.window.showErrorMessage.mock.calls[0][0]).toContain('conflicting');

  // The old pin is left exactly as it was — nothing half-written
  expect((vol.readFileSync(KNOWN_HOSTS, 'utf8') as string).trim()).to.eql(sharedLine);

  vscode.window.setWarningAnswer(undefined);
}, 60_000);
