# Pi Desktop 0.0.3

Release of the independent Pi-focused T3 Code fork maintained in `DavyMassoneto/t3code`, adding an optional bundled native Pi Desktop Auto Mode extension while keeping the Pi runtime external.

## New in 0.0.3

- Bundled Pi Desktop Auto Mode loads as a native Pi extension but stays inactive until explicitly selected and activated. Activation requires one broad confirmation covering arbitrary shell commands, file reads and writes, and network access without a sandbox. Once active, it adds no per-tool confirmations; third-party extensions' tool hooks and UI requests remain authoritative and are not overridden or auto-answered. Activation is session-local and resets when a session starts.
- The three basic access modes remain available. Generic Auto is no longer selectable in the access-mode picker or default settings; native Auto Mode is a separate, explicit opt-in policy.
- Native Pi policy discovery supports both machine-wide and project-local policies.
- Corrected the macOS canonical-path trust test fixture. This is a test-only fix, not a runtime behavior change.

## Inherited fix from 0.0.2

- Discover the npm-installed SDK for the selected Pi runtime using the actual runtime rather than assuming it is in the launcher's parent directories. This fixes SDK discovery for Windows native `.exe` launchers and NVM-managed installations.
- External Node.js, Git, and Pi 1.1.0 remain prerequisites; this release bundles the Auto Mode extension, not those runtimes, and does not migrate existing data.

## Distribution and data

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
