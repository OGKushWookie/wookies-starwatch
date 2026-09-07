# Wookie's Starwatch 2.2.0

Find the nearest publicly mapped 100% resource nodes from anywhere in the main Steam galaxy.

- Open **Nodes → Nearest perfect nodes** and choose Rocky, Icy, Gas, Crystal, or All resources.
- The nearest ten matching systems show distance and a **Plan route** button. Distances update after a jump or teleport without opening the game map.
- The launcher streams the official public `/systems` feed in a background thread and keeps only the compact perfect-node index. The full galaxy never enters the game renderer or its browser storage.
- The index is cached locally, refreshed at most hourly with gzip and ETags, and remains usable during temporary failures. Public discoveries remain separate from personal systems-seen totals and account map sync.
- Gold glows use lookups for systems already loaded on the game map. Duplicate public/personal results collapse to a single destination.
- Journal bodies now contribute confirmed personal perfect nodes, and journal timestamps are correctly read as milliseconds.

**Launcher replacement required:** download the new `WookiesStarwatch.exe`, exit the old Starwatch tray process, then start the new file. This release adds native API processing that older launchers cannot receive through an overlay-only update. Your existing API key, Steam link, favorites, and settings remain in their usual local storage. Ordinary compatible overlay updates remain automatic.

The public endpoint excludes owner-hidden systems and currently exposes X/Y for the main galaxy only. The finder shows straight-line nearest systems; Plan route separately evaluates fuel, cooldowns, and available portals. Personal history continues to use the API's default full-journal response; journal pagination is not enabled in this release.

Includes overlay 1.10.0. The Windows executable remains unsigned; SHA-256 checksums are included.
