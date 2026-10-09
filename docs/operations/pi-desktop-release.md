# Publishing Pi Desktop

The release owner manages commits, tags, and publication. The dedicated `Pi Desktop Release` workflow builds from a stable `X.Y.Z` or `vX.Y.Z` tag on fork `main`; use the bare tag `0.0.2`, matching version `0.0.2` in `apps/desktop/package.json`. The fork inherited upstream `v`-prefixed tags, including `v0.0.2`; preserve them without moving, deleting, or force-updating them. Push the new bare tag or manually dispatch the workflow with the existing bare tag. Do not use the upstream `Release` workflow: its entry job and npm publisher are restricted to `pingdotgg/t3code`.

Standard GitHub Windows x64, macOS arm64/x64, and Linux x64 runners build directly with `scripts/build-desktop-artifact.ts`. Each runner installs Rust and native prerequisites; the script builds the resource monitor and platform helpers itself. There is no dependency on upstream JavaScript or CLI release artifacts, no npm publication, no signing secrets, and no bundled Pi runtime. The Windows build does not embed a WSL runtime; use the native Windows backend for this initial release.

All four builds must succeed before publication. macOS updater manifests are merged across architectures, and `SHA256SUMS` covers the release assets. The publishing job creates a draft on `DavyMassoneto/t3code`, uploads assets, then makes it public. If an upload fails, the draft remains unpublished; rerunning resumes that draft and replaces its assets. An already public release is never overwritten.

Before each release, update the desktop version and release notes, validate the scoped packaging and desktop identity tests, and review the workflow diff. Initial builds are unsigned; the user prerequisites and warnings are in `pi-desktop-release-notes.md`.

For a local artifact on a host with its native toolchain installed:

```sh
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 --build-version 0.0.2 --output-dir release --verbose
```

Use `mac/dmg` or `linux/AppImage` on those hosts. Keep `T3CODE_DESKTOP_UPDATE_REPOSITORY=DavyMassoneto/t3code`; other repository destinations are rejected as update sources. Leave signing disabled. Do not set `T3CODE_HOME` to T3 Code's state directory.
