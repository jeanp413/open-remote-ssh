Changelog
=========

All notable changes to this project will be documented in this file.

[v0.4.0](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.4.0) | 2026-10-05
--------------------------------------------------------------------------------------

### Security

- bind local port to local ip. (#360)

### Changed

- support simple `ps` binary (#348)

### Added

- list hosts from multi-name `Host` lines and nested `Includes` (#332)

[v0.3.1](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.3.1) | 2026-08-05
--------------------------------------------------------------------------------------

### Bug fixes

- windows: use improved command to test archive (#331)

[v0.3.0](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.3.0) | 2026-08-04
--------------------------------------------------------------------------------------

### Changed

- add integrity check of the archive (#323)
- fall back to private key when .pub file parsing fails (#268)
- use official `simple-socks` (#324)

### Fixed

- sanitize the extension ids (#321)
- alpine: pass flock and expose error on missing libstdc++ (#315)
- macos: use a fixed file descriptor due to bash3 (#326)

### Added

- list configured SSH hosts in the Connect to Host prompt (#319)
- support `ForwardAgent` (#310)
- support PEM-encoded password-protected ssh keys (#249)
- add tests (#314)

[v0.2.0](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.2.0) | 2026-07-06
--------------------------------------------------------------------------------------

### Changed

- use base64 encoding for install script to support csh/tcsh login shells (#296)
- increase polling loop to aid slowish machines (#290)
- rename `serverBinaryName` setting (#280)
- extract install scripts from `serverSetup.ts` into script files (#287)

### Added

- add compatibility with Code-OSS (#189)
- linux: use `flock` to prevent multiple server install scripts running in parallel (#285)

[v0.1.2](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.1.2) | 2026-05-07
--------------------------------------------------------------------------------------

### Fixed

- split ProxyCommand into argv tokens before spawn (#274)

[v0.1.1](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.1.1) | 2026-05-03
--------------------------------------------------------------------------------------

### Fixed

- don't assume `ProxyCommand` value's type (#270)

[v0.1.0](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.1.0) | 2026-05-02
--------------------------------------------------------------------------------------

### Changed

- replace `which` with `command -v` (#215)
- cleanup on errors (#172)
- typo `attemp` -> `attempt` (#185)
- use original `ssh-config` dependency (#267)

### Added

- add `remote.SSH.serverInstallPath` option (#259)
- allow automatic download of remote extension host on FreeBSD (#244)


[v0.0.49](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.49) | 2025-04-04
----------------------------------------------------------------------------------------

### Changed

- remove default `remote.SSH.serverDownloadUrlTemplate`

[v0.0.48](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.48) | 2025-01-09
----------------------------------------------------------------------------------------

### Fixed

- add missing direct `@types/ssh2-stream` dependency (#177)
- fix Win32 internal error (#178)

### Added

- support `%n` in ProxyCommand

[v0.0.47](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.47) | 2024-11-09
----------------------------------------------------------------------------------------

### Added

- add support for loong64 (#175)
- add s390x support (#174)
- support vscodium alpine reh (#142)

[v0.0.46](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.46) | 2024-06-22
----------------------------------------------------------------------------------------

### Added

- add riscv64 support (#147)

[v0.0.45](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.45) | 2023-10-16
----------------------------------------------------------------------------------------

### Changed

- use windows-x64 server on windows-arm64

[v0.0.44](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.44) | 2023-10-01
----------------------------------------------------------------------------------------

### Fixed

- properly set `extensionHost` env variables

### Changed

- Update `ssh2` lib

[v0.0.43](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.43) | 2023-09-10
----------------------------------------------------------------------------------------

### Fixed

- parse multiple include directives

[v0.0.42](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.42) | 2023-08-31
----------------------------------------------------------------------------------------

### Fixed

- remote label to show port when connecting to a port other than 22

[v0.0.41](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.41) | 2023-08-31
----------------------------------------------------------------------------------------

### Fixed

- take into account parsed port from ssh destination (#110)

[v0.0.40](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.40) | 2023-08-17
----------------------------------------------------------------------------------------

### Changed

- Update `ssh-config` package

[v0.0.39](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.39) | 2023-06-12
----------------------------------------------------------------------------------------

### Added

- output error messages when downloading vscode server (#39)
- add `PreferredAuthentications` support (#97)

[v0.0.38](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.38) | 2023-06-05
----------------------------------------------------------------------------------------

### Added

- enable remote support for ppc64le (#93)

[v0.0.37](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.37) | 2023-05-24
----------------------------------------------------------------------------------------

### Changed

- default to current OS user in connection string if no user provided (#91)

### Added

- add support for (unofficial) DragonFly reh (#86)

[v0.0.36](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.36) | 2023-05-01
----------------------------------------------------------------------------------------

### Changed

- make `wget` support continue download (#85)

[v0.0.35](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.35) | 2023-04-29
----------------------------------------------------------------------------------------

### Fixed

- hardcoded `agentsock` for windows breaks pageant compatibility (#81)

[v0.0.34](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.34) | 2023-04-29
----------------------------------------------------------------------------------------

### Added

- add `remote.SSH.connectTimeout` setting

[v0.0.33](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.33) | 2023-04-07
----------------------------------------------------------------------------------------

### Added

- support `%r` user substitution in `proxycommand`

[v0.0.32](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.32) | 2023-03-26
----------------------------------------------------------------------------------------

### Added

- use `serverDownloadUrlTemplate` from `product.json` (#59)

[v0.0.31](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.31) | 2023-03-21
----------------------------------------------------------------------------------------

### Added

- support glob patterns in SSH include directives

[v0.0.30](https://github.com/jeanp413/open-remote-ssh/releases/tag/v0.0.30) | 2023-03-11
----------------------------------------------------------------------------------------

### Added

- support file patterns in SSH include directives
