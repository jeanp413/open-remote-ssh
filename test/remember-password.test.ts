import { randomUUID } from 'node:crypto';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { forgetSavedPasswords, getPasswordSecretKey } from '../src/ssh/savedPasswords';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';
import { sleep } from './utils/sleep';

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
const PASSWORD = 'first-password-1234';
const NEW_PASSWORD = 'changed-on-the-server';

const suffix = randomUUID().slice(0, 8);
const networkName = `open-remote-ssh-net-${suffix}`;
const hostName = `open-remote-ssh-pw-${suffix}`;
const targetName = `open-remote-ssh-pwtarget-${suffix}`;

let hostPort: number;
let hostKey: string;
let targetKey: string;

// One editor across all tests: its keychain survives each "reload"
const extContext = new vscode.ExtensionContext();
const logger = new Log('Remote - SSH');
let activeResolver: InstanceType<typeof RemoteSSHResolver> | undefined;

function resolveHost(host: string) {
  const resolver = new RemoteSSHResolver(extContext, logger);
  activeResolver = resolver;
  return resolver.resolve(getRemoteAuthority(host), new vscode.RemoteAuthorityResolverContext());
}

function setServerPassword(password: string) {
  runDocker(['exec', hostName, 'bash', '-c', `echo '${USERNAME}:${password}' | chpasswd`]);
}

function startContainer(name: string, publish: boolean) {
  runDocker(['rm', '-f', name], true);

  runDocker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--network',
    networkName,
    ...(publish ? ['--publish', '2222'] : []),
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
}

async function waitForTargetReady(timeoutMs: number) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = runDocker(
      ['exec', hostName, 'bash', '-c', `timeout 1 bash -c '</dev/tcp/${targetName}/2222' && echo READY`],
      true,
    );

    if (probe.includes('READY')) {
      return;
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for the target container to accept SSH');
}

beforeAll(async () => {
  vol.reset();

  runDocker(['network', 'rm', networkName], true);
  runDocker(['network', 'create', networkName]);

  startContainer(hostName, true);
  startContainer(targetName, false);

  hostPort = getMappedPort(hostName);
  hostKey = getPasswordSecretKey(USERNAME, '127.0.0.1', hostPort);
  targetKey = getPasswordSecretKey(USERNAME, targetName, 2222);

  await waitForSSHReady(USERNAME, PASSWORD, hostPort, 60_000, hostName);
  await waitForTargetReady(60_000);

  vol.fromJSON({
    '/etc/ssh/ssh_config': [
      'Host pwtest',
      '  HostName 127.0.0.1',
      `  Port ${hostPort}`,
      `  User ${USERNAME}`,
      '',
      'Host behind',
      `  HostName ${targetName}`,
      '  Port 2222',
      `  User ${USERNAME}`,
      '  ProxyJump pwtest',
    ].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });

  logger.capture();
}, 180_000);

afterEach(() => {
  activeResolver?.dispose();
  activeResolver = undefined;
  vscode.window.showInputBox.mockClear();
  vscode.window.showInformationMessage.mockClear();
});

afterAll(() => {
  vscode.workspace.resetConfiguration();
  runDocker(['rm', '-f', hostName], true);
  runDocker(['rm', '-f', targetName], true);
  runDocker(['network', 'rm', networkName], true);
});

it('prompts on first connect and offers to save the password', async () => {
  vscode.window.setPassword(PASSWORD);
  vscode.window.setInfoAnswer('Save');

  const result = await resolveHost('pwtest');
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showInputBox).toHaveBeenCalledOnce();
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Save the password for ${USERNAME}@127.0.0.1:${hostPort} in your keychain?`, 'Save', 'Not now');
  await vi.waitFor(() => expect(extContext.secrets.values.get(hostKey)).to.eql(PASSWORD));
}, 120_000);

it('reconnects with the saved password and no prompt', async () => {
  // Typing this would fail, so connecting proves the saved one was used
  vscode.window.setPassword('not-the-password');

  const result = await resolveHost('pwtest');
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
}, 60_000);

it('replaces the saved password once it changed on the server', async () => {
  setServerPassword(NEW_PASSWORD);
  vscode.window.setPassword(NEW_PASSWORD);
  vscode.window.setInfoAnswer('Save');

  const result = await resolveHost('pwtest');
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showInputBox).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(extContext.secrets.values.get(hostKey)).to.eql(NEW_PASSWORD));
}, 60_000);

it('forgets saved passwords', async () => {
  expect(await forgetSavedPasswords(extContext)).to.eql(1);
  expect(extContext.secrets.values.size).to.eql(0);
});

it('saves nothing after three wrong passwords', async () => {
  vscode.window.setPassword('not-the-password');
  vscode.window.setInfoAnswer('Save');

  await expect(resolveHost('pwtest')).rejects.toThrow();

  expect(vscode.window.showInputBox).toHaveBeenCalledTimes(3);
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  expect(extContext.secrets.values.size).to.eql(0);
}, 60_000);

it('saves nothing when declined', async () => {
  vscode.window.setPassword(NEW_PASSWORD);
  vscode.window.setInfoAnswer('Not now');

  const result = await resolveHost('pwtest');
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
  await sleep(100);
  expect(extContext.secrets.values.size).to.eql(0);
}, 60_000);

it('saves a ProxyJump hop\'s password under its own key', async () => {
  setServerPassword(PASSWORD);
  vscode.window.setPassword(PASSWORD);
  vscode.window.setInfoAnswer('Save');

  const result = await resolveHost('behind');
  expect(result.host).to.eql('127.0.0.1');

  expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
  expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => {
    expect(extContext.secrets.values.get(hostKey)).to.eql(PASSWORD);
    expect(extContext.secrets.values.get(targetKey)).to.eql(PASSWORD);
  });
}, 120_000);

it('never writes a password to the log', () => {
  const messages = logger.messages();
  expect(messages).toContain('Trying password authentication with the saved password');
  expect(messages).not.toContain(PASSWORD);
  expect(messages).not.toContain(NEW_PASSWORD);
  expect(messages).not.toContain('not-the-password');
});
