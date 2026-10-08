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

// The target is reached by container name, which becomes a DNS label on the
// network — keep the names well under the 63 character limit.
const suffix = randomUUID().slice(0, 8);
const networkName = `open-remote-ssh-net-${suffix}`;
const jumpName = `open-remote-ssh-jump-${suffix}`;
const targetName = `open-remote-ssh-target-${suffix}`;

let jumpPort: number;

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

// The target isn't published, so it can only be probed from inside the network.
async function waitForTargetReady(timeoutMs: number) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = runDocker(
      ['exec', jumpName, 'bash', '-c', `timeout 1 bash -c '</dev/tcp/${targetName}/2222' && echo READY`],
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

  startContainer(jumpName, true);
  startContainer(targetName, false);

  jumpPort = getMappedPort(jumpName);

  await waitForSSHReady(USERNAME, PASSWORD, jumpPort, 60_000);
  await waitForTargetReady(60_000);
}, 180_000);

afterAll(() => {
  runDocker(['rm', '-f', jumpName], true);
  runDocker(['rm', '-f', targetName], true);
  runDocker(['network', 'rm', networkName], true);
});

it('connects to a target reachable only through a ProxyJump host', async () => {
  vol.fromJSON({
    '/etc/ssh/ssh_config': [
      'Host test',
      // Only resolvable inside the docker network, so reaching it at all proves
      // the connection went through the jump host.
      `  HostName ${targetName}`,
      '  Port 2222',
      `  User ${USERNAME}`,
      `  Password ${PASSWORD}`,
      '  ProxyJump jump',
      '',
      'Host jump',
      '  HostName 127.0.0.1',
      `  Port ${jumpPort}`,
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
}, 120_000);
