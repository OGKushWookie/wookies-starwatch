# Overlay 1.11.0 — Dust Atlas

An automatic overlay update for the existing 2.2.0 launcher. No new EXE is needed.

- New **Dust** tab: cached, distance-driven heatmap of the Steam main galaxy, independent of the game's map.
- Galaxy, Region and Local views; all nine starter markers; current-player cross and selected-point ring.
- Mouse, keyboard and exact-coordinate inspection, with **My location** and **Plan route**.
- Verified base model: star value + 20 per body + LY to the nearest starter, using 10 LY per coordinate unit.
- Clear distinction between distance-only contributions, full base values when metadata is available, known systems and unverified coordinates.
- No assumed bonus stacking, personal net payout, or guarantee of a new discovery. Previously discovered systems are not repeat rewards.
- No extra game requests or cloud uploads. Local metadata is bounded to 6,000 records. Raster generation is chunked, cached and suspended outside the visible Dust tab.
- Stable canvas and input drafts during background refreshes, preserving the 1.10.1 dropdown fix.

The full public catalogue is not loaded into the renderer. Star/body totals use data already provided by the game and existing journal/user feeds. Missing fields remain unknown.
