# Open Remote - SSH

![Open Remote SSH](https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/docs/images/open-remote-ssh.gif)

## SSH Host Requirements
You can connect to a running SSH server on the following platforms.

**Supported**:

- x86_64 Debian 8+, Ubuntu 16.04+, CentOS / RHEL 7+ Linux.
- ARMv7l (AArch32) Raspbian Stretch/9+ (32-bit).
- ARMv8l (AArch64) Ubuntu 18.04+ (64-bit).
- macOS 10.14+ (Mojave)
- Windows 10+
- FreeBSD 13 (Requires manual remote-extension-host installation)
- DragonFlyBSD (Requires manual remote-extension-host installation)

## Requirements

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

[OpenSSH](https://www.openssh.com/) supports using a [configuration file](https://linuxize.com/post/using-the-ssh-config-file/) to store all your different SSH connections. To use an SSH config file, run the `Remote-SSH: Open SSH Configuration File...` command.

## Note for VSCode-OSS users

If you are using VSCode-OSS instead of VSCodium, you need some extra steps to make it work.

Modify the following entries in the plugin settings:

```
"remote.SSH.experimental.modifyMatchingCommit": true,
"remote.SSH.experimental.serverBinaryName": "codium-server",
```

Additionally, you may need to change the `vscodiumReleaseNumber`.
VSCodium versions have an extra `release` part that do not have equivalent for VSCode-OSS.
The plugin will use the latest release of the corresponding version. If you need to use another
VSCodium release, look for the release numbers associated with your VSCode version in the
[release page](https://github.com/VSCodium/vscodium/releases/).
For instance, for VSCode version "1.96.0", the (last) VSCodium release number is "24352".

In the plugin settings, modify the following entry to specify a particular release:

```
"remote.SSH.experimental.vscodiumReleaseNumber": "<vscodium-release>",
```

If left empty, it will pick the latest release:

```
"remote.SSH.experimental.vscodiumReleaseNumber": "",
```
