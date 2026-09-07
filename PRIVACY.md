# Privacy Notice — Private Beta

Wookie's Starwatch 1.10.0 is an unofficial, informational companion for Stellar Odyssey. Local-only features work without shared sync. Shared sync and completed-battle contribution are optional.

## Stored on this PC

The overlay stores its preferences and passive observations in the game renderer's browser storage. This can include favorites, profiles the game already loaded, XP/RSS snapshots, system coordinates, confirmed 100% nodes, routes, market settings, and simulator presets. Launcher 2.1.0 also keeps a small local queue of pending alert IDs, titles, messages, due times, expirations, and selected notification channels; it contains no game credentials and is cleared when Stellar Odyssey closes.

If an official API key is entered, the launcher encrypts it and minimized response caches with Windows DPAPI for the current Windows user under the pre-rebrand compatibility path `%LOCALAPPDATA%\Stellar Odyssey Intel Overlay`. The key is not placed in browser storage or sent to the companion database.

Launcher 2.2.0 also stores a compact, Windows-encrypted public perfect-node index at `perfect-node-index.bin`. It contains public system names, coordinates, perfect-node resource/body types, counts, and cache metadata. The complete public galaxy is streamed and discarded during processing. The public index is not uploaded to the companion database and does not become personal travel history. Removing or replacing the API key clears this index; temporary API failures retain the last usable snapshot with a stale-data notice.

## Stored by the companion service

After the shared-data notice is accepted and shared sync is enabled, the independent companion service can store:

- the Steam identifier used to link devices;
- the detected Stellar Odyssey account key and hashed device credentials;
- favorites and account-specific system/perfect-node discoveries;
- sanitized public profile, XP, and cumulative RSS observations;
- completed Arena/Squadron evidence only when battle contribution is separately enabled.

The service never receives Steam passwords, game cookies, game session credentials, official API keys, chat, inventory-material lists, or raw official API responses. Battle uploads replace player and squadron identities with side/slot labels before upload.

## Retention

The Dust Atlas keeps up to 6,000 compact local records containing game-system coordinates, star type, body count and system name, plus the last inspected coordinate/view. These come from data already loaded by normal gameplay or existing official feeds. Dust-specific records and selections are not uploaded to the companion service. The heatmap is generated locally and triggers no additional game/API requests. Clear overlay cache removes these browser-stored records.

Raw XP, RSS, and profile history is kept for seven days and then compacted into hourly/lifetime summaries. Latest public-profile/player summaries and compact historical aggregates are kept for analytics. Battle observations are retained for model development unless their reporting account is deleted. Local devices keep their own cache until it is cleared.

## Your controls

- Turn off **Enable shared history and map index** to stop synchronization.
- Turn off **Contribute anonymized completed battles** independently.
- Select **Disconnect this device** to revoke only this installation.
- Select **Delete linked cloud account data**, then type `DELETE`, to remove the Steam/device link, favorites, account map index, and raw submissions still attributable to the account.
- Use **Rules & Privacy → Clear overlay cache** to clear local browser-stored overlay data.
- Use **Sync → Remove key from this PC** to delete the DPAPI-protected API key and minimized API caches.

Cloud deletion cannot recall de-identified pooled statistical summaries or observations already merged into another user's local cache. Public profile information may be observed again during normal gameplay and contributed by another participating user.

## Diagnostic reports

The in-overlay diagnostic report contains versions, connection states, timestamps, queue sizes, and record counts. It deliberately excludes player names, coordinates, API keys, device credentials, recovery codes, profile contents, and raw observations. Review it before sharing if desired.
