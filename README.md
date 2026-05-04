# Discord Channel Media Downloader (Chrome MV3 extension)

Bulk-downloads **typical** image and video **attachments** (including GIF) from the Discord channel
currently open in your active tab. No DOM scraping — the extension passively
observes Discord's own auth header, then paginates the channel's full message
history via the official REST API and queues each attachment through
`chrome.downloads`.

## Read this first

Discord's Terms of Service prohibit automating actions on a user account
("self-bots"). Using your real account with this extension can get it banned.
**Use a throwaway account only.** That account must already be a member of the
server and have permission to read the channel's history.

This tool only downloads files that were directly uploaded as Discord
attachments. It does not download external embeds (Tenor gifs, YouTube
thumbnails, linked CDN URLs, etc.) — that was the explicit scope you asked for.

## What it does

1. When you visit `discord.com`, a tiny page-context shim wraps `fetch` and
   `XMLHttpRequest` so we can passively read the `Authorization`,
   `X-Super-Properties`, and locale headers Discord's own client already sends.
2. The popup shows the current server / channel parsed from the URL plus
   whether auth has been captured.
3. Click **Download all media in this channel**. The content script paginates
   `GET /api/v9/channels/<id>/messages?limit=100&before=<id>` from newest →
   oldest, throttled to ~55 requests / minute, with full 429 / `retry_after`
   handling and exponential backoff on 5xx.
4. For every message, attachments are accepted only if they look like normal
   consumer media: allowlisted extensions (e.g. PNG, JPEG, GIF, WebP, HEIC,
   AVIF, TIFF, BMP; MP4, WebM, MOV, MKV, AVI, MPEG, 3GP, …) **and** compatible
   MIME types. Broad `image/*` / `video/*` alone is not enough — e.g. SVG is
   skipped. `application/octet-stream` is allowed only when the filename
   extension is on the allowlist. Filenames are then checked
   against a dangerous-extension blocklist, common double-extension spoofs
   (e.g. `photo.jpg.exe`, `drop.exe.png`), and Unicode direction overrides
   (U+202E RTLO, zero-width spaces). Anything that fails is skipped; the popup
   shows **Skipped (security)**. The background worker re-checks every item
   before `chrome.downloads.download` (defense in depth).
5. The background service worker calls `chrome.downloads.download` with up
   to 4 concurrent transfers.
6. Files land at:
   ```
   <Chrome download dir>/DiscordMedia/<guildId>/<channelId>/<attachmentId>__<filename>
   ```
   Attachment IDs are unique snowflakes and double as the dedupe key so
   re-running on the same channel won't redownload anything.

## Install (developer mode)

1. Open `chrome://extensions/` in Chrome (or any Chromium-based browser:
   Edge, Brave, Vivaldi, Arc).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `extension/` folder of this repo.
4. Pin the extension to the toolbar so you can open the popup quickly.

The extension declares no remote code, no analytics, no third-party hosts.
All host permissions are scoped to `discord.com` and Discord's CDN domains.

## Usage

1. **Sign in** to Discord on your throwaway account at
   `https://discord.com/app`. Complete any captcha / phone verification
   manually.
2. **Join the server** that contains the channel you want to scrape. Make sure
   the account can actually open the channel and see history.
3. **Open the channel.** The URL must look like
   `https://discord.com/channels/<server-id>/<channel-id>`.
4. **Click around the channel once** so the Discord client makes an API
   request — the extension captures auth from that request. The popup will
   show "Auth captured: Yes" once it's ready (usually within a second).
5. **Open the extension popup** and click
   **Download all media in this channel**.
6. You can close the popup; the scrape runs inside the Discord tab and will
   continue until it hits the start of the channel or you click **Stop**.
7. Reopen the popup at any time to see live progress (messages scanned,
   attachments found, attachments queued, oldest message ID reached).

## Operational notes

- **Rate limits.** The pagination loop sleeps ≥1.1 s between requests. If
  Discord returns 429, the loop honors `retry_after` from the response body
  exactly. Network and 5xx errors get exponential backoff up to 6 attempts.
- **Auth refresh.** If you see `401 Unauthorized` mid-run, just click on a
  channel in Discord again to make the client send a fresh request — the
  shim will pick up the new token automatically.
- **Resumability.** The background service worker remembers every attachment
  ID it has successfully saved (in `chrome.storage.local`), so re-running on
  the same or partially-overlapping channels is idempotent. Use **Reset
  download dedupe cache** under "Advanced" in the popup to wipe that memory.
- **DMs / Group DMs.** They work too — the URL path `/channels/@me/<dm-id>`
  is parsed and downloads land under `DiscordMedia/dm/<dm-id>/`.
- **Threads.** Each thread has its own channel ID; open the thread directly
  to scrape it.
- **Concurrency.** Up to 4 simultaneous downloads from Discord's CDN. Discord
  CDN traffic is on a separate rate-limit pool from the API, so this is fine.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Popup says "Auth captured: No" forever | Click on a channel in Discord, then reopen the popup. If the page just loaded, give the client ~1 s. |
| 401 in the error box | Token rotated. Click around in Discord to re-capture, then start again. |
| 403 in the error box | Your account can't read that channel. Check role permissions. |
| 404 in the error box | Channel ID isn't valid for this account, or you left the server. |
| Downloads pop a "Save As" dialog for every file | Open `chrome://settings/downloads` and turn off **Ask where to save each file before downloading**. |
| Files have garbled names | Discord attachments are stored under `<id>__<original_filename>`. The original name is sanitized for Windows-illegal characters. |
| Service worker shows as inactive | Normal — MV3 wakes it on demand whenever the content script forwards a download batch. |

## File layout

```
extension/
  manifest.json     # MV3 manifest, host permissions for discord.com + CDN
  security.js       # Shared filename safety (blocklist, spoof patterns, RTLO strip)
  injected.js       # Page-context fetch/XHR shim (auth header capture, URL events)
  content.js        # Isolated-world orchestrator (pagination, throttling, dedupe)
  background.js     # Service worker (chrome.downloads queue, persistent dedupe set)
  popup.html        # Popup markup
  popup.css         # Dark Discord-ish styling
  popup.js          # Popup controller (live progress, start/stop, reset cache)
README.md
```

## What this tool intentionally does NOT do

- Make any modifications to your Discord account, messages, or settings.
- Send messages, react, type, join voice, or trigger any user-visible action
  in the Discord client.
- Touch external embeds, link previews, sticker bundles, custom emoji, or
  voice messages. Add explicit support yourself in `content.js` →
  `classifyAttachment` and the `*_EXT` / `*_MIMES` sets in `content.js` if you
  want to extend coverage.
- Use a bot token. This is purely a user-token scraper.
- Phone home. Zero analytics, zero remote endpoints other than Discord
  itself.
