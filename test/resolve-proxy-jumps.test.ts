import { describe, expect, it } from 'vitest';
import { MAX_PROXY_JUMPS, resolveProxyJumps } from '../src/authResolver';

function configuration(hosts: Record<string, Record<string, string>>) {
  return (host: string) => hosts[host] ?? {};
}

const names = (value: string, hosts: Record<string, Record<string, string>>) =>
  resolveProxyJumps(value, configuration(hosts)).map(([dest]) => dest.hostname);

describe('resolveProxyJumps', () => {
  it('keeps a comma separated list in order', () => {
    expect(names('a,b,c', {})).to.eql(['a', 'b', 'c']);
  });

  it('ignores blank entries', () => {
    expect(names('a,,b', {})).to.eql(['a', 'b']);
  });

  // A jump host has to be reachable before it can forward anything, so the
  // ProxyJump it declares comes first.
  it('walks a ProxyJump declared by a jump host', () => {
    expect(names('second', {
      second: { ProxyJump: 'first' },
    })).to.eql(['first', 'second']);
  });

  it('walks several levels', () => {
    expect(names('third', {
      third: { ProxyJump: 'second' },
      second: { ProxyJump: 'first' },
    })).to.eql(['first', 'second', 'third']);
  });

  it('expands each entry of a list', () => {
    expect(names('a,b', {
      a: { ProxyJump: 'a-gw' },
      b: { ProxyJump: 'b-gw' },
    })).to.eql(['a-gw', 'a', 'b-gw', 'b']);
  });

  it('carries the host configuration of every hop', () => {
    const hops = resolveProxyJumps('second', configuration({
      second: { ProxyJump: 'first', Port: '2022' },
      first: { HostName: 'gateway.example.com' },
    }));

    expect(hops.map(([dest]) => dest.hostname)).to.eql(['first', 'second']);
    expect(hops[0][1]).to.eql({ HostName: 'gateway.example.com' });
    expect(hops[1][1].Port).to.eql('2022');
  });

  it('keeps the user and port given in the value', () => {
    const [[dest]] = resolveProxyJumps('me@gateway:2022', configuration({}));

    expect(dest.hostname).to.eql('gateway');
    expect(dest.user).to.eql('me');
    expect(dest.port).to.eql(2022);
  });

  it('reports a chain that jumps back to itself', () => {
    expect(() => names('a', { a: { ProxyJump: 'a' } })).toThrow(/loops back to 'a'/);
  });

  it('reports a longer loop', () => {
    expect(() => names('a', {
      a: { ProxyJump: 'b' },
      b: { ProxyJump: 'a' },
    })).toThrow(/loops back to 'a'/);
  });

  it('stops an over long chain', () => {
    const hosts: Record<string, Record<string, string>> = {};
    for (let i = 0; i <= MAX_PROXY_JUMPS + 1; i++) {
      hosts[`h${i}`] = { ProxyJump: `h${i + 1}` };
    }

    expect(() => names('h0', hosts)).toThrow(/longer than/);
  });
});
