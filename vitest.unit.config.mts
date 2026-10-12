import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Host-independent unit tests.
 *
 * The suites in `./test/*.test.ts` drive a real SSH server inside a Linux
 * Docker container, so they can only run on a Linux host. The suites in
 * `./test/unit` don't touch the network or the filesystem, so CI can also run
 * them on Windows and macOS runners. See #343.
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
    include: ['./test/unit/**/*.test.ts'],
    reporters: 'dot',
    typecheck: {
      enabled: true,
    },
  },
});
