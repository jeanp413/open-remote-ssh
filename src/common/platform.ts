export const isWindows = process.platform === 'win32';
export const isMacintosh = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';
export const isFlatpak = !!process.env['FLATPAK_ID'];
