import { afterAll, describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../utils/with-platform';

async function splitProxyCommand(platform: NodeJS.Platform, value: string | string[]): Promise<string[]> {
  const { splitProxyCommand } = await withPlatform(platform, () => import('../../src/authResolver.js'));

  return splitProxyCommand(value);
}

afterAll(() => {
  vi.resetModules();
});

describe.each(['linux', 'darwin'] as const)('splitProxyCommand (%s)', (platform) => {
  it('splits on whitespace', async () => {
    expect(await splitProxyCommand(platform, 'ssh -W %h:%p bastion')).to.eql(['ssh', '-W', '%h:%p', 'bastion']);
  });

  it('collapses runs of whitespace', async () => {
    expect(await splitProxyCommand(platform, '  ssh   -W %h:%p  ')).to.eql(['ssh', '-W', '%h:%p']);
  });

  it('groups quoted tokens', async () => {
    expect(await splitProxyCommand(platform, '"/usr/local/bin/my proxy" -q %h')).to.eql(['/usr/local/bin/my proxy', '-q', '%h']);
  });

  it('treats backslash as an escape character', async () => {
    expect(await splitProxyCommand(platform, '/usr/local/bin/my\\ proxy -q')).to.eql(['/usr/local/bin/my proxy', '-q']);
  });

  it('passes arrays through', async () => {
    expect(await splitProxyCommand(platform, ['ssh', '-W', '%h:%p'])).to.eql(['ssh', '-W', '%h:%p']);
  });

  it('returns no token for an empty value', async () => {
    expect(await splitProxyCommand(platform, '')).to.eql([]);
  });
});

describe('splitProxyCommand (win32)', () => {
  it('splits on whitespace', async () => {
    expect(await splitProxyCommand('win32', 'ssh.exe -W %h:%p bastion')).to.eql(['ssh.exe', '-W', '%h:%p', 'bastion']);
  });

  it('groups quoted tokens', async () => {
    expect(await splitProxyCommand('win32', '"my proxy.exe" -q %h')).to.eql(['my proxy.exe', '-q', '%h']);
  });

  it('passes arrays through', async () => {
    expect(await splitProxyCommand('win32', ['ssh.exe', '-W', '%h:%p'])).to.eql(['ssh.exe', '-W', '%h:%p']);
  });

  // Windows OpenSSH doesn't support backslash escaping in `ProxyCommand`, so a
  // backslash is a path separator and must survive tokenization.
  //
  // `it.fails` documents the bug reported in #309: the tokenizer strips the
  // separators, the spawned process dies with ENOENT/EPIPE. The fix in #342
  // turns these back into plain `it`.
  it.fails('keeps the separators of an unquoted Windows path (#309)', async () => {
    expect(await splitProxyCommand('win32', 'C:\\Users\\me\\AppData\\Local\\coder\\coder.exe --global-config C:\\Users\\me\\AppData\\Roaming\\coderv2 ssh --stdio myworkspace')).to.eql([
      'C:\\Users\\me\\AppData\\Local\\coder\\coder.exe',
      '--global-config',
      'C:\\Users\\me\\AppData\\Roaming\\coderv2',
      'ssh',
      '--stdio',
      'myworkspace',
    ]);
  });

  it.fails('keeps the separators of a quoted Windows path (#309)', async () => {
    expect(await splitProxyCommand('win32', '"C:\\Program Files\\OpenSSH\\nc.exe" -X connect %h %p')).to.eql([
      'C:\\Program Files\\OpenSSH\\nc.exe',
      '-X',
      'connect',
      '%h',
      '%p',
    ]);
  });

  it.fails('keeps a trailing separator (#309)', async () => {
    expect(await splitProxyCommand('win32', 'C:\\tools\\proxy.exe --config C:\\tools\\conf\\')).to.eql([
      'C:\\tools\\proxy.exe',
      '--config',
      'C:\\tools\\conf\\',
    ]);
  });
});
