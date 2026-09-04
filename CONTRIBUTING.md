# Contributing

Keep changes informational and display-only. Do not add automatic clicks, travel, gathering, combat, marketplace actions, or unauthorized requests to game services.

Before proposing a change:

1. Run `node "Sync Service/test/release-static.mjs"`.
2. Run `./Source/Build-Portable.ps1` on Windows.
3. Confirm the launcher self-test passes and no secret, API key, credential, private signing key, or local Cloudflare state is included.
4. Describe any new data collected, transmitted, or retained and update `PRIVACY.md` when applicable.

Never commit `update-private.xml`. Overlay releases must use a monotonically increasing version and a newly signed immutable update asset.
