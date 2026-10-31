import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import fse from '@zokugun/fs-extra-plus/sync';
import { xtry, xtryAsync } from '@zokugun/xtry/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { Log } from './mocks/logger';
import * as vscode from './mocks/vscode';
import { runDocker } from './utils/run-docker';
import { getMappedPort } from './utils/get-mapped-port';
import { waitForSSHReady } from './utils/wait-for-ssh-ready';
import { getRemoteAuthority, RemoteSSHResolver } from '../src/authResolver';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(PROJECT_ROOT, 'lib');
const FIXTURE_ROOT = fse.join('.', 'test', 'fixtures', 'native');

type TestDocument = {
  client: {
    files: Record<string, string>;
    extensionConfiguration?: Record<string, string>;
  };
  server: {
    image: string;
    username: string;
    password: string;
    platform?: 'linux' | 'windows';
  };
  run?: {
    onlyInCI?: boolean;
  };
  test: {
    either?: string[] | string;
    error?: string[] | string;
    // The hosts the SSH config is expected to have.
    hosts?: string[];
    output?: string[] | string;
  };
};

const files = fse.walk(FIXTURE_ROOT, {
  absolute: true,
  onlyFiles: true,
  collect: true,
  filter: (item) => item.path.endsWith('.yml'),
});

if (files.fails) {
  throw files.error;
}

const extensionFiles = fse.walk(LIB_DIR, {
  absolute: true,
  collect: true,
  filter: (item) => {
    return !item.path.endsWith('.map')
          && (item.stats.isDirectory() || item.path.includes('native' + path.sep) || item.path.includes('scripts' + path.sep));
  },
});

if (extensionFiles.fails) {
  throw extensionFiles.error;
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

  const { client, server, test, run } = document.value as TestDocument;
  const containerName = `open-remote-ssh-test-${randomUUID()}`;

  if (run?.onlyInCI && !process.env.CI) {
    continue;
  }

  if ((server.platform === 'windows') !== (process.platform === 'win32')) {
    continue;
  }

  const rootDir = path.join(os.tmpdir(), `test-${name}`);
  describe(name, async () => {
    beforeAll(async () => {
      vscode.workspace.resetConfiguration();

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
      fse.rmdir(rootDir);
      runDocker(['rm', '-f', containerName], true);
    }, 120_000);

    it(`test-${name}`, async () => {
      vscode.setRootDir(rootDir);
      fse.mkdir(vscode.env.appRoot, { recursive: true});

      for (const [k,v] of Object.entries(client.files)) {
          if (k === 'product.json') {
            fse.writeFile(path.join(vscode.env.appRoot, k), v);
          } else {
            fse.writeFile(path.join(rootDir, k), v);
          }
      }

      const extContext = new vscode.ExtensionContext();
      for (const extFile of extensionFiles.value) {
        if( !extFile.stats.isDirectory() ) {
          copyFileOrDir(extFile.path, path.join(extContext.extensionPath, path.relative(PROJECT_ROOT, extFile.path)));
        }
      }

      if (client.files['ssh_config']) {
        vscode.workspace.setConfiguration('configFile', path.join(rootDir, 'ssh_config'));
      }
      if (client.extensionConfiguration) {
        for (const [k, v] of Object.entries(client.extensionConfiguration)) {
          vscode.workspace.setConfiguration(k, v);
        }
      }
      vscode.window.setPassword(server.password);

      const logger = new Log('Remote - SSH');
      const remoteSSHResolver = new RemoteSSHResolver(extContext, logger);
      const remoteContext = new vscode.RemoteAuthorityResolverContext();
      const authority = getRemoteAuthority('test');
      const expectedMessages = test?.error || test?.output || test?.either;

      if (expectedMessages) {
        logger.capture();
      }

      if (test?.error || test?.either) {
        const result = await xtryAsync(async () => await remoteSSHResolver.resolve(authority, remoteContext));

        if (test?.error) {
          expect(result.fails).toBe(true);
        }
      } else {
        const result = await remoteSSHResolver.resolve(authority, remoteContext);

        expect(result).toBeDefined();
        expect(result.host).to.eql('127.0.0.1');
      }

      if (expectedMessages) {
        const messages = logger.messages();

        if (Array.isArray(expectedMessages)) {
          for (const message of expectedMessages) {
            expect(messages).to.contains(message);
          }
        } else {
          if (!messages.includes(expectedMessages)) {
            console.log(messages);
          }

          expect(messages).to.contains(expectedMessages);
        }
      }
    }, 60_000);
  });
}

function copyFileOrDir(src: string, dest: string) {
  const from = path.resolve(src);
  const to = path.resolve(dest);
  fse.mkdir(path.dirname(to), { recursive: true });
  fse.cp(from, to, { recursive: true });
}
