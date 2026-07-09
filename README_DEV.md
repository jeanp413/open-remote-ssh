# For local development

## Installation
1. Npm install
```bash
npm install
```

2. Npm build
```bash
npm run build
```

## Packaging:
1. Install VSCE
```bash
npm install -g @vscode/vsce
```
2. Create the .vsix
```bash
vsce package
```

3. Install locally to test:
```bash
codium --install-extension ./open-remote-ssh-copy-0.2.1.vsix
```

## Potentially publishing the package on open-vsx.org
