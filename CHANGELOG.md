## 0.1.2
- fix: split ProxyCommand into argv tokens before spawn (#274)

## 0.1.1
- don't assume `ProxyCommand` value's type (#270)

## 0.1.0
- replace `which` with `command -v` (#215)
- allow automatic download of remote extension host on FreeBSD (#244)
- add remote.SSH.serverInstallPath option (#259)
- cleanup on errors (#172)
- typo `attemp` -> `attempt` (#185)
- use original ssh-config dependency (#267)

## 0.0.49
- remove default `remote.SSH.serverDownloadUrlTemplate`

## 0.0.48
- Support `%n` in ProxyCommand
- fix: add missing direct @types/ssh2-stream dependency (#177)
- fix Win32 internal error (#178)

## 0.0.47
- Add support for loong64 (#175)
- Add s390x support (#174)
- Support vscodium alpine reh (#142)

## 0.0.46
- Add riscv64 support (#147)

## 0.0.45
- Use windows-x64 server on windows-arm64

## 0.0.44
- Update ssh2 lib
- Properly set extensionHost env variables

## 0.0.43
- Fix parsing multiple include directives

## 0.0.42
- Fix remote label to show port when connecting to a port other than 22

## 0.0.41
- Take into account parsed port from ssh destination. Fixes (#110)

## 0.0.40
- Update ssh-config package

## 0.0.39

- output error messages when downloading vscode server (#39)
- Add PreferredAuthentications support (#97)

## 0.0.38

- Enable remote support for ppc64le (#93)

## 0.0.37

- Default to Current OS User in Connection String if No User Provided (#91)
- Add support for (unofficial) DragonFly reh (#86)

## 0.0.36

- Make wget support continue download (#85)

## 0.0.35

- Fixes hardcoded agentsock for windows breaks pageant compatibility (#81)

## 0.0.34

- Add remote.SSH.connectTimeout setting
- adding %r username replacement to proxycommand (#77)

## 0.0.33

- feat: support %r user substitution in proxycommand

## 0.0.32

- feat: use serverDownloadUrlTemplate from product.json (#59)

## 0.0.31

- feat: support glob patterns in SSH include directives

## 0.0.30

- feat: support file patterns in SSH include directives
