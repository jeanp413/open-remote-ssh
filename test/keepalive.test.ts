import { EventEmitter } from 'node:events';
import { Client } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { getKeepaliveConfig } from '../src/authResolver';
import SSHConnection from '../src/ssh/sshConnection';

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');

  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
  }

  /**
   * Minimal ssh2 Client stand-in. Like ssh2, a dropped connection emits
   * `close` on the client before it closes the channels still open on it.
   */
  class FakeClient extends EventEmitter {
    static last: FakeClient;
    stream = new FakeStream();

    constructor() {
      super();
      FakeClient.last = this;
    }

    connect(): this {
      queueMicrotask(() => this.emit('ready'));
      return this;
    }

    exec(_cmd: string, _options: unknown, cb: (err: Error | undefined, stream: FakeStream) => void): void {
      cb(undefined, this.stream);
    }

    drop(err: Error): void {
      this.emit('error', err);
      this.emit('close');
      this.stream.emit('close');
    }
  }

  return { Client: FakeClient };
});

type FakeStream = EventEmitter & { stderr: EventEmitter };

const FakeClient = Client as unknown as {
  last: EventEmitter & { stream: FakeStream; drop(err: Error): void };
};

describe('getKeepaliveConfig', () => {
  it('probes every 15s by default', () => {
    expect(getKeepaliveConfig({})).to.eql({ keepaliveInterval: 15000, keepaliveCountMax: 3 });
  });

  it('uses ServerAliveInterval and ServerAliveCountMax', () => {
    expect(getKeepaliveConfig({ ServerAliveInterval: '30', ServerAliveCountMax: '5' })).to.eql({ keepaliveInterval: 30000, keepaliveCountMax: 5 });
  });

  it('keeps ServerAliveInterval 0 as disabled', () => {
    expect(getKeepaliveConfig({ ServerAliveInterval: '0' }).keepaliveInterval).to.eql(0);
  });

  it('ignores unparsable values', () => {
    expect(getKeepaliveConfig({ ServerAliveInterval: 'yes', ServerAliveCountMax: '' })).to.eql({ keepaliveInterval: 15000, keepaliveCountMax: 3 });
  });
});

describe('SSHConnection.exec', () => {
  it('resolves with the output of a command that finished', async () => {
    const conn = new SSHConnection({ host: 'example', username: 'user' });
    const result = conn.exec('echo hi');
    await vi.waitFor(() => expect(FakeClient.last.stream.listenerCount('close')).to.eql(1));

    FakeClient.last.stream.emit('data', 'hi\n');
    FakeClient.last.stream.emit('close');

    await expect(result).resolves.to.eql({ stdout: 'hi\n', stderr: '' });
  });

  // The install script used to resolve with empty output here, so a
  // connection lost mid-reconnect was reported as a failed install
  it('rejects when the connection drops while the command runs', async () => {
    const conn = new SSHConnection({ host: 'example', username: 'user' });
    const result = conn.exec('echo hi');
    await vi.waitFor(() => expect(FakeClient.last.stream.listenerCount('close')).to.eql(1));

    FakeClient.last.drop(new Error('Keepalive timeout'));

    await expect(result).rejects.toThrow(/connection closed while running 'echo': Keepalive timeout/);
  });

  it('rejects execPartial when the connection drops before the tester matched', async () => {
    const conn = new SSHConnection({ host: 'example', username: 'user' });
    const result = conn.execPartial('echo hi', stdout => stdout.includes('done'));
    await vi.waitFor(() => expect(FakeClient.last.stream.listenerCount('close')).to.eql(1));

    FakeClient.last.stream.emit('data', 'partial');
    FakeClient.last.drop(new Error('Keepalive timeout'));

    await expect(result).rejects.toThrow(/Keepalive timeout/);
  });
});
