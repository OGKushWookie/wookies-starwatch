# Troubleshooting — Private Beta

## Windows warns about the launcher

The private-beta launcher is not commercially code-signed. Download it only from the official project release and compare `WookiesStarwatch.exe` with that release's SHA-256 value. On systems that allow unsigned apps, Windows may offer **More info → Run anyway**. Smart App Control may block it without an override. Do not disable Microsoft Defender or another antivirus product.

## The launcher cannot find the game

Run `WookiesStarwatch.exe` and look for its notification-area icon. It can start before or after the game. Start Stellar Odyssey from Steam and wait for the main interface; the status changes from **Waiting for Stellar Odyssey** to **Active** automatically.

## The overlay button is missing

Double-click the notification-area icon or choose **Open overlay**. The launcher automatically reinjects after a renderer restart. If its status remains waiting while the game's main interface is visible, exit and restart the launcher, then open **Open diagnostics folder** from its menu if the problem persists.

## Steam linking does not open

Open Sync, acknowledge the shared-data notice, and select **Connect with Steam**. If Windows suppresses the browser window, select the visible **Open Steam sign-in** link. Return to the game after Steam confirms the account.

## Shared sync fails

Confirm that Sync shows the expected Stellar Odyssey account, that the data notice is accepted, and that the device is connected through Steam. Temporary Cloudflare or network errors back off automatically. Use **Copy privacy-safe diagnostic report** before reporting a persistent problem.

## The official API fails

The API key is separate from Steam linking and must be entered once on each PC. Remove and re-add the key if it was regenerated. Cached feeds intentionally do not refresh continuously because the official service has per-endpoint limits.

## A cooldown alert does not appear while another app is open

Confirm the notification-area menu or the Alerts tab reports launcher 2.1.0 or newer. Open the galaxy map once while a positive engine countdown is visible; this arms the Windows scheduler for that cooldown. Keep `WookiesStarwatch.exe` running in the notification area, enable at least one of **Audio chime**, **Screen / taskbar flash**, or **Desktop notification**, and use **Test selected notifications**. If audio works but no banner appears, check Windows Notifications and Focus Assist / Do Not Disturb settings. The launcher intentionally clears pending game alerts after Stellar Odyssey closes.

## A profile or ranking is missing

Only the local player, squad members, and favorites are listed. Another player's complete public data is available only after that profile was naturally opened by a participating player. Rates also need enough time-separated observations to calibrate.

## Map marks or routes are missing

Open and pan the native galaxy map. Perfect nodes require an exact, timestamped `nodeQuality = 100` observation. Route drawings appear only after a route is planned and **Show planned route on maps** remains enabled.

## Reporting a beta issue

Include:

1. what you expected and what happened;
2. the tab or map view involved;
3. a screenshot with private chat cropped if necessary;
4. the privacy-safe diagnostic report copied from Sync or Rules & Privacy;
5. whether restarting the game and launcher changed the result;
6. the relevant lines from the compatibility-path log `%LOCALAPPDATA%\Stellar Odyssey Intel Overlay\launcher.log` after removing anything you do not want to share.
