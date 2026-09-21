import { describe, expect, it } from 'vitest';
import SSHDestination from '../src/ssh/sshDestination';
import { getProxyJumpPort } from '../src/authResolver';

describe('getProxyJumpPort', () => {
  it('uses the hop\'s own Port', () => {
    expect(getProxyJumpPort(SSHDestination.parse('jump'), { Port: '2022' })).to.eql(2022);
  });

  it('uses the port given in the ProxyJump value', () => {
    expect(getProxyJumpPort(SSHDestination.parse('jump:2022'), {})).to.eql(2022);
  });

  it('prefers the hop\'s Port over the one in the ProxyJump value', () => {
    expect(getProxyJumpPort(SSHDestination.parse('jump:2022'), { Port: '2023' })).to.eql(2023);
  });

  // A jump host does not inherit the target's Port. Both call sites used to
  // compute this differently, so the first hop of a target on a non-default
  // port was dialed on that port instead of 22.
  it('falls back to 22, never to the target\'s port', () => {
    expect(getProxyJumpPort(SSHDestination.parse('jump'), {})).to.eql(22);
  });

  it('ignores an unparsable Port', () => {
    expect(getProxyJumpPort(SSHDestination.parse('jump'), { Port: '' })).to.eql(22);
  });
});
