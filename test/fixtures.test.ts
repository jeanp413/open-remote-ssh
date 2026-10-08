import { randomUUID } from 'node:crypto';
import fse from '@zokugun/fs-extra-plus/sync';
import { xtry, xtryAsync } from '@zokugun/xtry/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { RemoteSSHResolver, SSHConfiguration, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';

const ROOT = fse.join('.', 'test', 'fixtures', 'default');
const SERVER_SETUP_BASH = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;
const SERVER_SETUP_POWERSHELL = fse.readFile('./src/scripts/server-setup.ps1', 'utf8').value!;

type TestDocument = {
  client: {
    files: Record<string, string>;
  };
  server: {
    image: string;
    username: string;
    password: string;
    platform?: 'linux' | 'windows';
  };
  test: {
    error?: string[] | string;
    // The hosts the SSH config is expected to have.
    hosts?: string[];
    output?: string[] | string;
  };
};

const files = fse.walk(ROOT, {
  absolute: true,
  onlyFiles: true,
  collect: true,
  filter: (item) => item.path.endsWith('.yml'),
});

if (files.fails) {
  throw files.error;
}

for (const file of files.value) {
  const name = fse.leafName(file.path, 1);
  const content = fse.readFile(file.path, 'utf8');
  if (content.fails) {
    throw content.error;
  }

  const document = xtry(() => YAML.parse(content.value) as unknown);
  if (document.fails) {
    throw document.error;
  }

  const { client, server, test } = document.value as TestDocument;
  const containerName = `open-remote-ssh-test-${randomUUID()}`;

  if ((server.platform === 'windows') !== (process.platform === 'win32')) {
    continue;
  }

  describe(name, async () => {
    beforeAll(async () => {
      vol.reset();

      if(!server.image.startsWith('local-')) {
        runDocker(['pull', server.image]);
      }

      runDocker(['rm', '-f', containerName], true);

      runDocker([
        'run',
        '--detach',
        '--rm',
        '--name',
        containerName,
        '--publish',
        '2222:2222',
        '--env',
        `USER_NAME=${server.username}`,
        '--env',
        `USER_PASSWORD=${server.password}`,
        '--env',
        'PASSWORD_ACCESS=true',
        '--env',
        'SUDO_ACCESS=false',
        '--env',
        'LOG_STDOUT=true',
        server.image,
      ]);

      const hostPort = getMappedPort(containerName);

      await waitForSSHReady(server.username, server.password, hostPort, 60_000, containerName);
    }, 120_000);

    afterAll(() => {
      runDocker(['rm', '-f', containerName], true);
    });

    it(`test-${name}`, async () => {
      vol.fromJSON({
        ...client.files,
        '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP_BASH,
        '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.ps1': SERVER_SETUP_POWERSHELL,
      });

      vscode.window.setPassword(server.password);

      if (test?.hosts) {
        const config = await SSHConfiguration.loadFromFS();

        expect(config.getAllConfiguredHosts()).to.eql(test.hosts);
      }

      const logger = new Log('Remote - SSH');
      const extContext = new vscode.ExtensionContext();
      const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
      const remoteContext = new vscode.RemoteAuthorityResolverContext();
      const authority = getRemoteAuthority('test');

      if (test?.error || test?.output) {
        logger.capture();
      }

      if (test?.error) {
        const result = await xtryAsync(async () => await remoteSSHResolver.resolve(authority, remoteContext));

        expect(result.fails).toBe(true);
      } else {
        const result = await remoteSSHResolver.resolve(authority, remoteContext);

        expect(result).toBeDefined();
        expect(result.host).to.eql('127.0.0.1');
      }

      if (test?.error || test?.output) {
        const expected = test?.error || test?.output;
        const messages = logger.messages();

        if (Array.isArray(expected)) {
          for (const message of expected) {
            expect(messages).to.contains(message);
          }
        } else {
          if (!messages.includes(expected!)) {
            console.log(messages);
          }

          expect(messages).to.contains(expected!);
        }
      }
    }, 60_000);
  });
}
