import { randomUUID } from 'node:crypto';
import fse from '@zokugun/fs-extra-plus/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
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
const PASSWORD = 'openremotessh';

// Container names become DNS labels on the network, so keep them short.
const suffix = randomUUID().slice(0, 8);
const networkName = `open-remote-ssh-nested-net-${suffix}`;
const jump1Name = `ors-jump1-${suffix}`;
const jump2Name = `ors-jump2-${suffix}`;
const targetName = `ors-target-${suffix}`;

let jump1Port: number;

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

// Only the first hop is published, the rest live inside the network.
async function waitForInsideNetwork(host: string, timeoutMs: number) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = runDocker(
      ['exec', jump1Name, 'bash', '-c', `timeout 1 bash -c '</dev/tcp/${host}/2222' && echo READY`],
      true,
    );

    if (probe.includes('READY')) {
      return;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${host} to accept SSH`);
}

beforeAll(async () => {
  vol.reset();

  runDocker(['network', 'rm', networkName], true);
  runDocker(['network', 'create', networkName]);

  startContainer(jump1Name, true);
  startContainer(jump2Name, false);
  startContainer(targetName, false);

  jump1Port = getMappedPort(jump1Name);

  await waitForSSHReady(USERNAME, PASSWORD, jump1Port, 60_000);
  await waitForInsideNetwork(jump2Name, 60_000);
  await waitForInsideNetwork(targetName, 60_000);
}, 240_000);

afterAll(() => {
  runDocker(['rm', '-f', jump1Name], true);
  runDocker(['rm', '-f', jump2Name], true);
  runDocker(['rm', '-f', targetName], true);
  runDocker(['network', 'rm', networkName], true);
});

// The target names a single jump host, and that jump host names another one.
// Reaching the target requires walking the whole chain, which is what ssh does.
it('follows a ProxyJump declared by a jump host', async () => {
  vol.fromJSON({
    '/etc/ssh/ssh_config': [
      'Host test',
      `  HostName ${targetName}`,
      '  Port 2222',
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
      '  ProxyJump jump2',
      '',
      'Host jump2',
      // Only resolvable from inside the network, so it can only be reached
      // through jump1.
      `  HostName ${jump2Name}`,
      '  Port 2222',
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
      '  ProxyJump jump1',
      '',
      'Host jump1',
      '  HostName 127.0.0.1',
      `  Port ${jump1Port}`,
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
    ].join('\n'),
    '/bin/vscodium/app/product.json': PRODUCT_JSON,
    '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
  });

  vscode.window.setPassword(PASSWORD);

  const logger = new Log('Remote - SSH');
  const extContext = new vscode.ExtensionContext();
  const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
  const remoteContext = new vscode.RemoteAuthorityResolverContext();
  const authority = getRemoteAuthority('test');
  const result = await remoteSSHResolver.resolve(authority, remoteContext);

  expect(result).toBeDefined();
  expect(result.host).to.eql('127.0.0.1');

  remoteSSHResolver.dispose();
}, 150_000);
