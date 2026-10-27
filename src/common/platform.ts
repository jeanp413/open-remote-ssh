export const isWindows = process.platform === 'win32';
export const isMacintosh = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Platform values accepted by the `remote.SSH.remotePlatform` setting.
 */
export type RemotePlatform = 'linux' | 'macos' | 'windows';
