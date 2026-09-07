# Wookie's Starwatch — Portable Private Beta

This is an unofficial, display-only companion for a small trusted test group. It does not click controls, travel, gather, start combat, or automate gameplay.

This project's original code is provided under the included MIT License. Stellar Odyssey remains the property of its respective rights holders.

## Install and start

1. Download `WookiesStarwatch.exe` from the official project release. If it was supplied in a ZIP, extract it first; the EXE itself is the only runtime file.
2. Compare its SHA-256 value with the checksum on that release page when possible.
3. Double-click the EXE before or after starting Stellar Odyssey.
4. Leave its icon in the Windows notification area; it waits for the game and reconnects automatically.
5. Open the slim **Starwatch** tab on the game's right edge, press **Alt+I**, or double-click the notification-area icon.

The launcher is not commercially code-signed, so Windows may identify it as an unknown publisher. On systems that permit unsigned apps, confirm the download source and checksum before using **More info → Run anyway**. Never disable antivirus protection. Windows Smart App Control may block it completely; use a signed future build on those systems.

## Optional account features

Launcher 2.2.0 adds **Nodes → Nearest perfect nodes**. Add your official API key in Sync, choose a resource type, and the nearest ten exact 100% matches update as your position changes. The public map is processed in the background and cached hourly. Results do not increase your personal travel count. Exit an older Starwatch tray process before starting this new EXE.

- **Steam linking:** Open Sync, read and accept the shared-data notice, then select **Connect with Steam**. This carries favorites, account map discoveries, and pooled observations across PCs.
- **Official read-only API:** Paste the key from your own in-game profile once per PC. It remains Windows-encrypted locally and is separate from Steam linking.
- **Battle contribution:** Off by default. Enable it separately only if you want completed Arena/Squadron evidence already loaded by the game to contribute to the anonymous model.

Read **PRIVACY.md** before enabling shared sync and **KNOWN ISSUES.md** before relying on estimates. For help, see **TROUBLESHOOTING.md** and use **Copy privacy-safe diagnostic report** in the Sync or Rules & Privacy tab.

The one-file launcher contains an offline fallback and checks the companion service for signed overlay updates. Verified updates are cached in LocalAppData and ordinary UI updates do not require another download. Only an infrequent native-launcher change requires replacing the EXE.

Launcher 2.1.0 also owns the background alert clock. Open the galaxy map once while an engine countdown is visible, then the selected audio, Windows notification, or taskbar-flash channel can fire while the game is minimized or behind another application. Leave the Starwatch notification-area icon running and use **Alerts → Test selected notifications** to verify the PC's Windows settings.

To uninstall, remove the official API key in Sync, disconnect or delete the linked cloud account if desired, exit the notification-area launcher, and delete the EXE. If **Start with Windows** was enabled, turn it off from the tray menu first. For compatibility with existing installations, cached files remain under `%LOCALAPPDATA%\Stellar Odyssey Intel Overlay`; no installed game files are changed.
