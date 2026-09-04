# Wookie's Starwatch 2.1.0

This native-launcher update adds reliable Windows background alerts.

- Engine-ready alerts continue while Stellar Odyssey is minimized or behind another application after the visible map countdown has armed the monitor.
- Selected background channels can show a Windows notification, play the Starwatch three-tone chime, and flash the game's taskbar button.
- Exposed personal operation timers use the same persistent local scheduler; new event and market alerts can hand off to Windows while the game is in the background.
- Foreground alerts keep the existing in-game toast, edge pulse, and ready badge without a second native alert.
- Pending alerts are local, contain no credentials, send no game requests, and are cleared when the game closes.

Replace the older launcher EXE with `WookiesStarwatch.exe`; overlay updates remain automatic after that. This build is unsigned, so verify the published SHA-256 checksum before running it.
