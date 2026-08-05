import { randomUUID } from 'node:crypto';
import fse from '@zokugun/fs-extra-plus/sync';
import { xtry } from '@zokugun/xtry/sync';
import { vol } from 'memfs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { RemoteSSHResolver, getRemoteAuthority } from './rewires/remote';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';

const ROOT = fse.absolute('.', 'test', 'fixtures');
const SERVER_SETUP = fse.readFile('./src/scripts/server-setup.sh', 'utf8').value!;

type ClientOptions = {
  files: Record<string, string>;
};

type ServerOptions = {
  image: string;
  username: string;
  password: string;
};

type ExpectedResult = {
  log?: {level: string; message: string}[];
};

const files = fse.walk(ROOT, {
  absolute: true,
  onlyFiles: true,
  collect: true,
  filter: (item) => item.path.endsWith('.yml'),
  traverseAll: true,
});

if (files.fails) {
  throw files.error;
}

for (const file of files.value) {
  const name = file.path.slice(ROOT.length + 1).replace(/\.yml$/, '').replaceAll(fse.separator, '-');
  const content = fse.readFile(file.path, 'utf8');
  if (content.fails) {
    throw content.error;
  }

  const document = xtry(() => YAML.parse(content.value) as unknown);
  if (document.fails) {
    throw document.error;
  }

  const { client, server, expected } = document.value as { client: ClientOptions; server: ServerOptions; expected: ExpectedResult };
  const containerName = `open-remote-ssh-test-${randomUUID()}`;

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

      await waitForSSHReady(server.username, server.password, hostPort, 60_000);
    }, 120_000);

    afterAll(() => {
      runDocker(['rm', '-f', containerName], true);
    });

    it(`test-${name}`, async () => {
      vol.mkdirSync('/tmp');
      vol.fromJSON({
        ...client.files,
        '/data/vscodium/extensions/open-remote-ssh/src/scripts/server-setup.sh': SERVER_SETUP,
      });

      vscode.window.setPassword(server.password);

      const logger = new Log('Remote - SSH', Boolean(expected?.log));
      const extContext = new vscode.ExtensionContext();
      const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
      const remoteContext = new vscode.RemoteAuthorityResolverContext();
      const authority = getRemoteAuthority('test');
      const result = await remoteSSHResolver.resolve(authority, remoteContext);

      expect(result).toBeDefined();
      expect(result.host).to.eql('127.0.0.1');

      if(expected?.log) {
        for(const {level, message} of expected.log) {
          if(message.startsWith('!')) {
            expect(logger.hasInclusiveMessage(level, message.slice(1))).to.eql(false);
          }
          else {
            expect(logger.hasInclusiveMessage(level, message)).to.eql(true);
          }
        }
      }
    }, 40_000);
  });
}
