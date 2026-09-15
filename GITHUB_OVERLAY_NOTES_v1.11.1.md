# Overlay 1.11.1 — PvM compatibility repair

An overlay-only repair for the existing 2.2.0 launcher; no replacement EXE is required.

- Restores the official NPC comparison, maximum-level scan, and stat-allocation optimizer after the September game update.
- Identifies the shared combat library in the installed Steam entry bundle instead of relying on a changing minified export name.
- Validates the library interface before running; unknown formats show a compatibility error instead of trying unrelated game functions.
- Reads only local installed files for discovery, on demand, and caches a successful engine load. No added game-server requests, automated battles, or gear changes.
- Clears predictions from an older game bundle while keeping editable builds and settings.
- Adds regression tests for export renaming, local-only reads, cached/concurrent loading, stale predictions, safe failure, and retry.

Calculations still use the game's own local simulator; they are not a guarantee of server outcomes or an independent claim of perfect accuracy.
