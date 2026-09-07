# Known Issues — Wookie's Starwatch 1.11.0 / Launcher 2.2.0 Private Beta

- Dust Atlas colors show the distance contribution to base discovery dust, not personalized net payout. Bonus stacking, tax and server rounding are not modeled. The atlas covers Steam Z 1 only.
- Dust totals need observed star type and full body count. This release uses already-loaded game data and existing journal/user feeds, not a second full public catalogue. Oldest local metadata is evicted beyond 6,000 records.
- Coordinates without cached data are unverified, not guaranteed undiscovered. Known systems do not offer repeat discovery rewards; public-feed omissions can include hidden systems.

- Public nearest-perfect search requires launcher 2.2.0 and a locally configured official API key. Owner-hidden systems are excluded. The public feed provides only the main galaxy (Z 1); other layers use personal observations only. New discoveries can take until the next hourly refresh to appear.
- Nearest means straight-line coordinate distance, not the fastest portal-assisted journey. Select Plan route for fuel/cooldown/portal comparisons.
- The public index is processed off the renderer on a low-priority native thread. A first download still uses network and CPU briefly; only the compact index is kept. The renderer caches sorting and draws glows only for loaded systems.
- Journal paging is not used yet. The existing full-history journal request remains bounded by the helper's 32 MiB general-feed limit; exceptionally large personal journals may still need paging support in a future release.

- The Windows launcher is not commercially code-signed. SmartScreen may show an unknown-publisher warning, and Smart App Control can block it. Verify the release checksum; do not disable antivirus protection.
- The overlay currently supports the Windows Steam/Electron build. Launcher 2.1.0 monitors the game from the notification area and normally reinjects automatically after the game or renderer restarts.
- Background engine alerts require the map countdown to be observed once for that cooldown and `WookiesStarwatch.exe` to remain running in the Windows notification area. Focus Assist, Do Not Disturb, or disabled app notifications can hide a desktop banner; audio and taskbar attention remain separate selected channels.
- The launcher EXE does not replace itself. Ordinary signed overlay code updates are automatic; changes to native launcher behavior or the official-API allow-list require downloading a newer EXE.
- A game-client update can rename internal stores or simulator exports. The overlay fails closed where possible, but profiles, map decorations, or the NPC lab may temporarily become unavailable.
- Public-player data is passive. Missing gear, catalysts, locations, or rates stay blank until normal gameplay exposes the relevant profile or location.
- XP/RSS estimates require elapsed history. Active XP needs repeated continuous gain intervals; RSS needs at least an hour. Sparse players remain calibrating.
- PvP predictions are experimental. Hidden opponent bonuses and server RNG cannot be reconstructed exactly; confidence should improve as opted-in battle evidence grows.
- PvM uses the game's installed local simulator, but maximum-level predictions should be compared with real NPC outcomes after game updates. Input fields are only as accurate as the build data exposed by the client.
- Route plans are optimal within the known coordinate/fuel/portal model. Unknown systems, unavailable portals, future travel mechanics, and starter-to-starter teleportation are not invented.
- Official API data is deliberately cached to protect endpoint quotas: most feeds for at least 30 minutes and market history for at least one hour.
- Live individual marketplace listings are not fetched. Market tools use the official hourly history feed.
- Cloud deletion removes directly attributable account data but cannot recall de-identified pooled aggregates or copies already synchronized to another device.
