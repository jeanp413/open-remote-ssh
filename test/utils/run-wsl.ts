import { spawnSync } from 'node:child_process';

export type WslResult = {
  status: number;
  stdout: string;
  stderr: string;
};

/**
 * `wsl.exe` writes UTF-16LE for its own messages (`--version`, `--list`, ...)
 * but passes distribution output through as-is. Decode defensively: strip the
 * BOM and the NUL padding rather than assuming one encoding.
 */
function decode(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.subarray(2).toString('utf16le');
  }

  return buffer.toString('utf8');
}

export function wsl(args: string[], options: { input?: string; allowFailure?: boolean } = {}): WslResult {
  const result = spawnSync('wsl.exe', args, {
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  const out: WslResult = {
    status: result.status ?? -1,
    stdout: decode(result.stdout ?? Buffer.alloc(0)).replace(/\0/g, '').trim(),
    stderr: decode(result.stderr ?? Buffer.alloc(0)).replace(/\0/g, '').trim(),
  };

  if (out.status !== 0 && !options.allowFailure) {
    throw new Error(`wsl ${args.join(' ')} failed (${out.status}): ${out.stderr || out.stdout}`);
  }

  return out;
}

/**
 * Run a bash script inside `distro` as root.
 *
 * The script is fed through stdin rather than written to a file: a script
 * authored on Windows picks up CRLF line endings, and bash reports every line
 * as `$'\r': command not found`. stdin keeps the bytes exactly as written here.
 */
export function wslBash(distro: string, script: string, options: { allowFailure?: boolean } = {}): WslResult {
  return wsl(['--distribution', distro, '--user', 'root', '--', 'bash', '-s'], {
    input: script.replace(/\r\n/g, '\n'),
    allowFailure: options.allowFailure,
  });
}

export function isWslUsable(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  const version = wsl(['--version'], { allowFailure: true });

  return version.status === 0 && /WSL version:\s*2\./.test(version.stdout);
}

export function hasDistro(distro: string): boolean {
  const list = wsl(['--list', '--quiet'], { allowFailure: true });

  return list.status === 0 && list.stdout.split(/\r?\n/).some((line) => line.trim() === distro);
}

export function installDistro(distro: string): void {
  if (hasDistro(distro)) {
    return;
  }

  wsl(['--install', '--no-launch', '--distribution', distro]);

  if (!hasDistro(distro)) {
    throw new Error(`WSL reported success but ${distro} is not registered`);
  }
}

export function terminateDistro(distro: string): void {
  wsl(['--terminate', distro], { allowFailure: true });
}
