# Open Remote - SSH

![Open Remote SSH](https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/docs/images/open-remote-ssh.gif)

## SSH Host Requirements
You can connect to a running SSH server on the following platforms.

**Supported**:

- x86_64 Debian 8+, Ubuntu 16.04+, CentOS / RHEL 7+ Linux
- ARMv7l (AArch32) Raspbian Stretch/9+ (32-bit)
- ARMv8l (AArch64) Ubuntu 18.04+ (64-bit)
- IBM Z (s390x) Debian 13, RHEL 8+, Ubuntu 22.04+, SLES 15+
- macOS 10.14+ (Mojave)
- Windows 10+
- FreeBSD 13+ (Requires custom serverDownloadUrlTemplate setting)
- DragonFlyBSD (Requires manual remote-extension-host installation)

## Requirements

**Configuration**

You SSH server's configuration needs to have the following setting:
- `AllowTcpForwarding yes`

**Activation**

> NOTE: Not needed in VSCodium since version 1.75

Enable the extension in your `argv.json`


```json
{
    ...
    "enable-proposed-api": [
        ...,
        "jeanp413.open-remote-ssh",
    ]
    ...
}
```
which you can open by running the `Preferences: Configure Runtime Arguments` command.
The file is located in `~/.vscode-oss/argv.json`.

**Alpine linux**

When running on alpine linux, the packages `libstdc++` and `bash` are necessary and can be installed via
running
```bash
sudo apk add bash libstdc++
```

## SSH configuration file

[OpenSSH](https://www.openssh.com/) supports using a [configuration file](https://linuxize.com/post/using-the-ssh-config-file/) to store all your different SSH connections.
To use an SSH config file, run the `Remote-SSH: Open SSH Configuration File...` command.

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

- `ProxyJump` set inside a hop's own `Host` block is ignored
  ([#109](https://github.com/jeanp413/open-remote-ssh/issues/109)). List the whole
  chain on the target instead, e.g. `ProxyJump bastion,inner`.
- `ProxyJump none` is not recognized yet. It is treated as a host named `none`. To
  exclude a host from a wildcard, use a negated pattern instead: `Host * !bastion`.
- If both `ProxyJump` and `ProxyCommand` are set, `ProxyJump` is used.

## Note for VSCode-OSS users

If you are using VSCode-OSS instead of VSCodium, you need some extra steps to make it work.

Modify the following entries in the plugin settings:

```
"remote.SSH.serverBinaryName": "codium-server",
"remote.SSH.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz",
"remote.SSH.serverVersion": "latest",
"remote.SSH.serverValidation": "force",
```

VSCodium versions have an extra `release` part that do not have equivalent for VSCode-OSS.
So leaving `serverVersion` to the default `"match"` will fail.
The plugin will install the latest release of VSCodium if `serverVersion` is set to `"latest"`.
If you need to match the VSCode-OSS version, set `serverVersion` to `"closest"`, to
automatically fetch the last release of VSCodium for this version.

You can look for the release numbers associated with your VSCode version in the
[release page](https://github.com/VSCodium/vscodium/releases/). For instance, for VSCode
version "1.96.0", the (last) VSCodium release number is "24352".

You can also set `serverVersion` to a specic version (e.g. "1.116.0") or a specific
version-release (e.g. "1.116.02821").

If the local and remote VSCodium versions don't match, which will be the case on VSCode-OSS,
remote server validation needs to be bypassed. Setting `serverValidation` to `"force"` will
modify the commit of the remote server to make it match the local VSCode commit.
If `serverValidation` is set to `"skip"`, the remote server will skip checking that the commits
match. This option is working only if the remote VSCodium version is `>=1.120`.

Starting with VSCodium version 1.99.0, the `release` number is not separated from the `version` by a dot `.` anymore.
Therefore `serverDownloadUrlTemplate` needs to be filled with the new scheme (as shown above).

Before 1.99.0, the old scheme needs to be used:

```
"remote.SSH.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz",
```
