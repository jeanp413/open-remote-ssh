import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * The Windows suites that do not go through Docker.
 *
 * `./test/unit` is host-independent. `./test/windows` drives a real Linux
 * `sshd` inside WSL2 and skips itself when WSL2 is unavailable.
 *
 * `./test/*.test.ts` is deliberately not included: the `windows` job already
 * runs `fixtures.test.ts` against the Windows-remote images, and the two jobs
 * cover opposite remotes. See #343.
 */
export default defineConfig({
  oxc: {
    target: 'es2022',
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, './test/mocks/vscode.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['./test/unit/**/*.test.ts', './test/windows/**/*.test.ts'],
    reporters: 'dot',
    // The WSL suite provisions a distribution, installs sshd and installs the
    // remote server over SSH. Serialised so the two host entries don't race for
    // the same port.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 600_000,
    typecheck: {
      enabled: true,
    },
  },
});
