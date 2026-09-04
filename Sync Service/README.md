# Wookie's Starwatch Sync Service

This optional Cloudflare Worker + D1 service makes sanitized public profile, XP, RSS, and completed-battle observations cumulative across participating overlay users. It synchronizes favorites and each account's passively observed system/perfect-node index through a Steam-linked account while issuing a different revocable credential to each device. Private recovery codes remain supported for older installations.

Service 1.3.1 adds authenticated `POST /v1/account/delete`. A currently linked Steam device must provide its device credential, matching loaded-account key, and the literal `DELETE` confirmation. The operation removes account/device links, favorites, account systems, request-limit rows, and raw XP/RSS/profile/battle submissions still carrying that account's reporter identifier. De-identified pooled state, hourly/lifetime summaries, model coefficients, and copies already synchronized to clients are intentionally not claimed to be recallable; the overlay discloses this before deletion.

The service is separate from Stellar Odyssey. It never contacts the game server, requests profiles, receives official API keys, or triggers game actions. Launcher 1.2.0's optional official-API helper runs only on the player's PC; the overlay sends sanitized observations here only after shared history is enabled in the Sync tab.

Service 1.3.0 uses versioned D1 migrations and exact monotonic change cursors. Frequently changing XP/RSS rows are de-duplicated by player/minute, ranking clients receive compact window summaries, and detailed history is returned only when the XP tab asks for one selected player. RSS observations must be explicitly profile-derived and cumulative; leaderboard/cache rows and decreasing totals are rejected. Perfect nodes require a timestamped, exact `nodeQuality = 100` observation, and a newer non-perfect observation can revoke an older record across devices. Legacy unverified node rows remain useful for systems-seen history but are not returned as confirmed perfect nodes. Completed Arena/Squadron records are size-limited, schema-normalized, stripped of identity fields, hashed for deduplication, and folded into incremental model statistics. Profile-matched combat inputs train at full weight; battle-log proxies train at a lower rate. Separate coefficients are retained for defense, armor penetration, lifesteal, stun, block, DoT, precision, and evasion. A daily Cron Trigger compacts old XP/RSS rows and cleans expired request/link records. Table and index creation never runs in the live sync request path.

## Deployed instance

The service is deployed at `https://stellar-odyssey-intel-sync.sthess28.workers.dev`. Its `/health` endpoint was verified after deployment. The included `wrangler.toml` is linked to the live D1 database so the account owner can deploy future Worker updates.

## Automatic overlay releases

The Worker also hosts the signed update channel under `public/updates` using Cloudflare static assets. `manifest.json` points to an immutable, versioned overlay file. The Windows launcher verifies the manifest with its embedded RSA public key, verifies the overlay's SHA-256 checksum, and replaces only the adjacent `overlay.js` file.

Starting with overlay 1.0.1, the client generates the random Steam link-request ID before contacting the service. This lets the original user click open a visible browser URL immediately. If the browser reaches the Worker just before the client's setup request, the Worker serves a short self-refreshing waiting page and then redirects to Steam once the request exists. Older clients that rely on server-generated IDs remain supported.

The RSA private signing key is intentionally **not** included in either distributable ZIP or the ChatGPT Project upload. Keep the private key on a trusted release machine and in a separate encrypted backup. A normal release consists of copying the new overlay to a versioned filename, generating and signing a new manifest, and deploying the Worker. Changing the launcher, its embedded public key, or the update protocol requires a one-time manual launcher release.

## Deploy again or replace the hosted instance

1. Install Node.js 20 or newer.
2. Open a terminal in this folder and run `npm install`.
3. Run `npx wrangler login` and approve the Cloudflare login.
4. To update the existing instance, skip database creation and run `npm run db:migrate:remote`, followed by `npm run deploy`.
5. To create a separate instance, run `npm run db:create`, replace the existing database ID in `wrangler.toml` with the returned ID, then run `npm run db:migrate:remote` and `npm run deploy`.
6. For a separate instance, enter its resulting HTTPS Worker URL in the overlay's **Sync → Companion endpoint** field.

For local testing, replace the database ID first, run `npm run db:migrate:local`, then run `npm run dev`. Use the displayed `http://127.0.0.1:8787` address in the overlay.

## Favorites on another PC

Open your own Stellar Odyssey profile, select **Connect with Steam**, and approve the Steam browser page. Repeat on another PC using the same Steam account. The overlay detects the currently loaded game username and receives a unique device credential automatically. Nothing is copied between PCs.

The device credential is stored in the overlay's local browser storage so synchronization can reconnect after restart. It can be revoked from the Sync tab. Steam authentication is handled by Steam's OpenID page; the service never receives a Steam password. Recovery codes should still be treated like passwords if the fallback mode is used.

## Stored data

- Sanitized public profile snapshots: username, squadron, displayed levels and statistics, public gear/catalysts, pets, and technology.
- XP observations for battling, gathering, crafting, and exploring.
- Cumulative profile-only RSS observations used for RSS/hour calculations; leaderboard totals are excluded from rates.
- The Steam ID used to associate installations with the same account.
- Per-device credential hashes, link expiration/status, and last-seen timestamps.
- Favorites associated with the linked account or legacy recovery-code hash.
- Account-scoped system coordinates already exposed through normal map use, first-seen times, timestamped exact-100 verification, and sanitized 100% resource-node labels.
- Anonymous completed-battle records: side/slot participant labels, visible levels/build summaries, Arena/Squadron round events, and visible clone/catalyst combat attributes. Usernames, squadron names, and internal game IDs are removed before upload.

Steam passwords, inventory materials, game cookies, game tokens, raw game responses, and private chat content are not accepted or stored. Steam OpenID verification contacts Steam Community only and never contacts Stellar Odyssey's server.
