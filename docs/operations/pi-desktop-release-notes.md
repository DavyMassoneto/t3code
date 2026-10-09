# Pi Desktop 0.0.1

First native desktop release of the independent Pi-focused T3 Code fork maintained in `DavyMassoneto/t3code`.

- Windows x64 NSIS installer; macOS arm64 and x64 DMG/ZIP; Linux x64 AppImage and Debian package.
- Independent Pi Desktop application identity, `pi-desktop://` links, Electron profile, and `~/.pi-desktop/userdata` server state. Existing T3 Code installations and default data are not migrated or overwritten. Pi's own credentials and sessions remain in `~/.pi`.
- Optional Linux capture helpers use separate Pi Desktop KDE/Hyprland installation paths and a separate GNOME extension UUID and D-Bus identity. Installing or removing these integrations does not replace the upstream T3 Code helpers.
- Desktop update metadata points only to `DavyMassoneto/t3code`, never the upstream repository. No npm package is published.

## Before launching

Install system Node.js (Node 24 recommended) and Git, then install the external Pi runtime used by this release:

```sh
npm install -g @earendil-works/pi-coding-agent@1.1.0
pi --version
```

Pi is not bundled. Ensure `node`, `git`, and `pi` are available on the desktop application's PATH, and configure Pi provider credentials before starting an agent. On Windows, install Git for Windows including Git Bash. Restart the application after changing PATH.

## Initial unsigned builds

These initial builds are unsigned and macOS builds are not notarized. Windows SmartScreen or macOS Gatekeeper may warn or block launch. Only authorize an installer downloaded from this fork's release after verifying its SHA-256 against `SHA256SUMS`; organizational policies may prohibit unsigned software. Linux AppImages may need executable permission (`chmod +x Pi-Desktop-*.AppImage`).

This is not a zero-prerequisite distribution. Not every native Pi terminal feature has a graphical equivalent; see [Pi setup and graphical limitations](../user/providers-pi.md). This is an early release: retain backups, and do not point `T3CODE_HOME` at an existing T3 Code data directory. Native installer and update behavior require platform acceptance testing; macOS and Linux runtime behavior has not been verified locally.
