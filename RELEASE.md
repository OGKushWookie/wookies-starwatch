# Release and Rollback Guide

## Private-beta release gate

- Run JavaScript syntax checks for `overlay.js` and `Sync Service/src/index.js`.
- Build `WookiesStarwatch.exe` with `Source/Build-Portable.ps1` and require its embedded-overlay self-test to pass.
- Run `Source/Test-PerfectIndex.ps1` and `Sync Service/test/perfect-finder.mjs`. Confirm the native helper returns compact cached results quickly while a cold index rebuild continues in the background.
- Confirm the overlay version, signed manifest version, update asset name, and SHA-256 are identical.
- Verify the distributable excludes the private RSA signing key, Cloudflare local state, dependency folders, and credentials.
- Test the one-file launcher from a clean folder with no adjacent `overlay.js`: before the game, while the game is open, and across a renderer restart.
- Arm a short engine-alert test, place another application in the foreground, and verify the launcher delivers each selected native channel without a duplicate foreground notification.
- Check `/health`, Steam linking, a normal sync, diagnostics copying, and the update channel.
- Preserve the prior signed update asset and release ZIP.

## Publishing an overlay update

Use the private signing script in `work/release-signing/Publish-OverlayUpdate.ps1` on the trusted release PC, then deploy the Worker. Never place `update-private.xml` in an output, upload, source archive, or cloud project.

## Rollback

The launcher intentionally does not downgrade to a numerically older manifest. To roll back bad overlay code, copy the last known-good source into a **new higher patch version**, sign that version, deploy it, and verify the remote manifest/hash. This preserves monotonic updates and prevents downgrade attacks.

## Operations

- Keep an encrypted backup of the update-signing key separate from the workspace.
- Monitor Worker errors, D1 row reads/writes, storage, and request volume during beta expansion.
- Treat changes to the launcher, embedded update key, local API allow-list, or update protocol as a manual launcher release. Ordinary signed overlay changes remain automatic.
- Acquire a reputable Windows code-signing certificate before a broad public release.
- Until then, publish the unsigned EXE and its SHA-256 checksum as separate GitHub release assets and clearly document possible SmartScreen/Smart App Control behavior.
