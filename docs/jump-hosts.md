## Jump hosts

To reach a host that is only accessible through a bastion, set `ProxyJump` in your
SSH config, the same way you would for `ssh -J`:

```
Host bastion
    HostName bastion.example.com
    User alice

Host internal
    HostName 10.0.0.12
    User deploy
    ProxyJump bastion
```

Then connect to `internal` as usual. The extension connects to `bastion` first and
opens the connection to `internal` through it.

For more than one hop, list them in order, separated by commas **without spaces**:

```
Host deep
    HostName 10.1.0.5
    ProxyJump bastion,inner
```

A hop's own `ProxyJump` is followed as well, so the same chain can also be declared
host by host:

```
Host inner
    HostName 10.1.0.1
    ProxyJump bastion

Host deep
    HostName 10.1.0.5
    ProxyJump inner
```

A chain that loops back on itself is reported as an error.

A hop can also be written inline as `[user@]host[:port]` without a `Host` block of
its own, e.g. `ProxyJump alice@bastion.example.com:2222`.

**How each hop is resolved**

| Setting | Taken from, in order |
| --- | --- |
| `HostName` | the hop's `Host` block → the name in `ProxyJump` |
| `User` | the hop's `Host` block → `user@` in `ProxyJump` → the target's `User` |
| `Port` | the hop's `Host` block → `:port` in `ProxyJump` → `22` |
| `IdentityFile`, `IdentitiesOnly`, `ForwardAgent` | the hop's `Host` block |

A hop never inherits the target's `Port`. If the hop's user is different from the
target's, set `User` on the hop explicitly.

**Requirements**

Every jump host needs `AllowTcpForwarding yes` in its `sshd_config`, because the
connection to the next hop is opened as a forwarded channel.

**Limitations**

- `ProxyJump none` is not recognized yet. It is treated as a host named `none`. To
  exclude a host from a wildcard (e.g. the bastion itself), use a negated pattern
  instead: `Host * !bastion`.
- If both `ProxyJump` and `ProxyCommand` are set, `ProxyJump` is used.
