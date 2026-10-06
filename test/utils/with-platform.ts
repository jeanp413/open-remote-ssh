import { vi } from 'vitest';

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

/**
 * Run `load()` as if the extension were running on `platform`.
 *
 * `src/common/platform.ts` derives `isWindows`/`isMacintosh`/`isLinux` from
 * `process.platform` the first time it's loaded, so the override has to be in
 * place *before* the module is imported, and the module registry has to be
 * reset between loads. This keeps platform-specific code paths testable from
 * any host.
 *
 * `load` must be an inline dynamic import so the specifier stays relative to
 * the caller, e.g.:
 *
 * ```ts
 * const mod = await withPlatform('win32', () => import('../../src/authResolver.js'));
 * ```
 */
export async function withPlatform<T>(platform: NodeJS.Platform, load: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });

  vi.resetModules();

  try {
    return await load();
  }
  finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
