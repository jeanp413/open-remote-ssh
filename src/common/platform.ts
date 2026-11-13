export const isWindows = process.platform === 'win32';
export const isMacintosh = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

export const enum Platform {
	Mac,
	Linux,
	Windows
}
export type PlatformName = 'Windows' | 'Mac' | 'Linux';

export function PlatformToString(platform: Platform): PlatformName {
	switch (platform) {
		case Platform.Mac: return 'Mac';
		case Platform.Linux: return 'Linux';
		case Platform.Windows: return 'Windows';
	}
}

let _platform: Platform = Platform.Linux;
if (isMacintosh) {
	_platform = Platform.Mac;
} else if (isWindows) {
	_platform = Platform.Windows;
}

export const platform = _platform;

/**
 * Platform values accepted by the `remote.SSH.remotePlatform` setting.
 */
export type RemotePlatform = 'linux' | 'macos' | 'windows';
