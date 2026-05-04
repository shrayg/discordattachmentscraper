// Runs in the ISOLATED world on every discord.com page at document_start.
// `security.js` is listed first in manifest.json so stripDangerousUnicode /
// analyzeFilenameSecurity exist in this shared scope (classic scripts only).
// Responsibilities:
//   1. Listen for postMessages from injected.js (auth header + URL changes).
//   2. Persist the latest captured auth + channel context to chrome.storage so
//      the popup and background can read it.
//   3. When the popup sends START, paginate the active channel via Discord's
//      REST API, filter for image/video attachments, dedupe, and forward the
//      download list to the background service worker in chunks.
//   4. Emit progress events the popup subscribes to.
//
// Architecture notes:
//   - Orchestration lives here (not in popup) so closing the popup does not
//     stop a scrape. The Discord tab stays open during the run.
//   - All state is kept in module-scope variables AND mirrored to
//     chrome.storage.local so the popup can show live progress when reopened.
//   - Rate limits: we throttle paginated /messages calls to one per
//     ~MIN_REQUEST_INTERVAL_MS, honor 429 retry-after, and exponentially back
//     off on transient 5xx errors.

const STORAGE_KEYS = {
  auth: "dcmd_auth",
  channel: "dcmd_channel",
  status: "dcmd_status",
};

const MIN_REQUEST_INTERVAL_MS = 1100; // ~55 req/min, well under Discord's 50/sec global cap
const MAX_RETRIES = 6;
const PAGE_SIZE = 100; // Discord max per /messages call
const DOWNLOAD_CHUNK = 25; // forward to background in batches

// Typical consumer image formats only (GIF included). No SVG/ICO — not what
// most people mean by "channel media", and SVG can carry scripts.
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif",
]);
// Typical consumer video formats only.
const VIDEO_EXT = new Set([
  "mp4", "m4v", "mov", "webm", "mkv", "avi", "mpeg", "mpg", "3gp", "3g2", "ogv",
]);

const TYPICAL_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-bmp",
  "image/x-ms-bmp",
  "image/tiff",
  "image/x-tiff",
  "image/heic",
  "image/heif",
  "image/avif",
]);
const TYPICAL_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/mpeg",
  "video/mpg",
  "video/3gpp",
  "video/3gpp2",
  "video/ogg",
]);

const state = {
  auth: null, // { authorization, "x-super-properties"?, "x-discord-locale"? }
  url: location.href,
  channelId: null,
  guildId: null,
  isRunning: false,
  abortRequested: false,
  // progress
  messagesScanned: 0,
  attachmentsFound: 0,
  attachmentsSkippedSecurity: 0,
  attachmentsQueued: 0,
  oldestMessageId: null,
  startedAt: 0,
  finishedAt: 0,
  lastError: null,
};

// ---------- helpers --------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * (ms * 0.25));

function parseChannelFromUrl(url) {
  // https://discord.com/channels/{guild_id|@me}/{channel_id}
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/channels\/([^/]+)\/([^/?#]+)/);
    if (!m) return { guildId: null, channelId: null };
    return { guildId: m[1], channelId: m[2] };
  } catch {
    return { guildId: null, channelId: null };
  }
}

function baseMimeType(contentType) {
  return String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/**
 * Typical image / video / GIF attachments. Images still require a matching
 * extension when the filename has one. Videos trust Discord's `video/*` and
 * `application/mp4` unless the filename extension is clearly image-only
 * (spoof guard at top).
 * @returns {"image" | "video" | null}
 */
function classifyAttachment(att) {
  const baseMime = baseMimeType(att.content_type);
  const name = stripDangerousUnicode(att.filename || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  const extImage = ext && IMAGE_EXT.has(ext);
  const extVideo = ext && VIDEO_EXT.has(ext);
  const mimeImage = TYPICAL_IMAGE_MIMES.has(baseMime);
  const mimeVideo = TYPICAL_VIDEO_MIMES.has(baseMime);

  // Cross-kind mismatch: do not download
  if (extImage && (mimeVideo || baseMime.startsWith("video/"))) return null;
  if (extVideo && (mimeImage || baseMime.startsWith("image/"))) return null;

  if (mimeImage) {
    if (!ext || extImage) return "image";
    return null;
  }
  // Typical video MIME from Discord / clients — allow even when the filename
  // extension is missing or odd (mobile uploads, renamed clips). Still block
  // obvious cross-kind spoof (image extension + video MIME) above.
  if (mimeVideo) {
    if (extImage) return null;
    return "video";
  }

  // Some stacks label MP4 as application/mp4 instead of video/mp4.
  if (baseMime === "application/mp4") {
    if (extImage) return null;
    return "video";
  }

  // Discord sometimes uses application/octet-stream; trust filename only then.
  if (!baseMime || baseMime === "application/octet-stream") {
    if (extImage) return "image";
    if (extVideo) return "video";
    return null;
  }

  // Non-typical image/* (e.g. image/svg+xml) — only allow if extension matches
  if (baseMime.startsWith("image/")) {
    if (extImage) return "image";
    return null;
  }
  // Any other video/* (codecs variants, vendor types) — trust unless filename
  // is clearly an image type only.
  if (baseMime.startsWith("video/")) {
    if (extImage) return null;
    return "video";
  }

  return null;
}

async function persistStatus() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.status]: {
        isRunning: state.isRunning,
        messagesScanned: state.messagesScanned,
        attachmentsFound: state.attachmentsFound,
        attachmentsSkippedSecurity: state.attachmentsSkippedSecurity,
        attachmentsQueued: state.attachmentsQueued,
        oldestMessageId: state.oldestMessageId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        lastError: state.lastError,
        channelId: state.channelId,
        guildId: state.guildId,
      },
    });
  } catch (_) {
    // storage may be unavailable during page teardown
  }
}

function broadcastProgress() {
  try {
    chrome.runtime.sendMessage({
      type: "DCMD_PROGRESS",
      payload: {
        isRunning: state.isRunning,
        messagesScanned: state.messagesScanned,
        attachmentsFound: state.attachmentsFound,
        attachmentsSkippedSecurity: state.attachmentsSkippedSecurity,
        attachmentsQueued: state.attachmentsQueued,
        oldestMessageId: state.oldestMessageId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        lastError: state.lastError,
        channelId: state.channelId,
        guildId: state.guildId,
      },
    }).catch(() => {}); // popup may be closed
  } catch (_) {}
}

// ---------- inbound: page-script + popup messages --------------------------

window.addEventListener("message", (event) => {
  // Strict validation: must come from this window, our origin, and carry the
  // source tag the injected script stamps. This blocks fake events from
  // injected iframes or other extensions.
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.__dcmd_src !== "DCMD_PAGE") return;

  if (data.type === "auth" && data.headers?.authorization) {
    const next = data.headers;
    // Avoid spamming storage if unchanged.
    if (
      !state.auth ||
      state.auth.authorization !== next.authorization ||
      state.auth["x-super-properties"] !== next["x-super-properties"]
    ) {
      state.auth = next;
      chrome.storage.local.set({ [STORAGE_KEYS.auth]: { capturedAt: Date.now() } }).catch(() => {});
    }
  } else if (data.type === "url") {
    state.url = data.url;
    const { guildId, channelId } = parseChannelFromUrl(data.url);
    state.guildId = guildId;
    state.channelId = channelId;
    chrome.storage.local.set({
      [STORAGE_KEYS.channel]: { guildId, channelId, url: data.url },
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "DCMD_GET_STATE") {
    sendResponse({
      hasAuth: !!state.auth?.authorization,
      url: state.url,
      guildId: state.guildId,
      channelId: state.channelId,
      isRunning: state.isRunning,
      messagesScanned: state.messagesScanned,
      attachmentsFound: state.attachmentsFound,
      attachmentsSkippedSecurity: state.attachmentsSkippedSecurity,
      attachmentsQueued: state.attachmentsQueued,
      oldestMessageId: state.oldestMessageId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      lastError: state.lastError,
    });
    return true; // keep channel open for sync response
  }
  if (msg.type === "DCMD_START") {
    if (state.isRunning) {
      sendResponse({ ok: false, error: "Already running" });
      return true;
    }
    if (!state.auth?.authorization) {
      sendResponse({
        ok: false,
        error: "No auth captured yet. Click around in Discord (open the channel) and try again.",
      });
      return true;
    }
    if (!state.channelId) {
      sendResponse({
        ok: false,
        error: "No channel detected in URL. Open a channel first (URL must look like /channels/<server>/<channel>).",
      });
      return true;
    }
    runScrape().catch((err) => {
      state.lastError = err?.message || String(err);
      state.isRunning = false;
      state.finishedAt = Date.now();
      persistStatus();
      broadcastProgress();
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "DCMD_STOP") {
    if (state.isRunning) {
      state.abortRequested = true;
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "Not running" });
    }
    return true;
  }
});

// ---------- core scrape loop ----------------------------------------------

async function fetchMessagesPage({ channelId, before }) {
  const url = new URL(`https://discord.com/api/v9/channels/${channelId}/messages`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (before) url.searchParams.set("before", before);

  const headers = {
    Accept: "*/*",
    Authorization: state.auth.authorization,
  };
  if (state.auth["x-super-properties"]) headers["X-Super-Properties"] = state.auth["x-super-properties"];
  if (state.auth["x-discord-locale"]) headers["X-Discord-Locale"] = state.auth["x-discord-locale"];
  if (state.auth["x-discord-timezone"]) headers["X-Discord-Timezone"] = state.auth["x-discord-timezone"];

  let attempt = 0;
  // Retry loop with exponential backoff for 429/5xx
  // (network errors also bubble up here)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let res;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        credentials: "include",
        headers,
        mode: "cors",
        cache: "no-store",
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw new Error(`Network error: ${err.message}`);
      await sleep(jitter(1000 * 2 ** (attempt - 1)));
      continue;
    }

    if (res.status === 429) {
      let retryAfter = 1.5;
      try {
        const body = await res.clone().json();
        if (typeof body.retry_after === "number") retryAfter = body.retry_after;
      } catch (_) {
        const ra = res.headers.get("retry-after");
        if (ra) retryAfter = parseFloat(ra);
      }
      await sleep(jitter(Math.max(500, Math.ceil(retryAfter * 1000))));
      continue;
    }

    if (res.status === 401) {
      throw new Error("401 Unauthorized \u2014 Discord rejected the token. Re-open the channel in this tab to refresh auth.");
    }
    if (res.status === 403) {
      throw new Error("403 Forbidden \u2014 your account cannot read this channel's history.");
    }
    if (res.status === 404) {
      throw new Error("404 Not Found \u2014 channel ID is invalid or you are not a member.");
    }
    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`Discord ${res.status} after ${MAX_RETRIES} retries`);
      await sleep(jitter(1000 * 2 ** (attempt - 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Unexpected ${res.status} from Discord`);
    }

    return res.json();
  }
}

async function runScrape() {
  state.isRunning = true;
  state.abortRequested = false;
  state.messagesScanned = 0;
  state.attachmentsFound = 0;
  state.attachmentsSkippedSecurity = 0;
  state.attachmentsQueued = 0;
  state.oldestMessageId = null;
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.lastError = null;

  const channelId = state.channelId;
  const guildId = state.guildId || "dm";

  await persistStatus();
  broadcastProgress();

  const seenMessageIds = new Set();
  const seenAttachmentIds = new Set();
  let pendingDownloads = [];
  let lastRequestAt = 0;
  let before = null;

  const flush = async (force) => {
    if (!pendingDownloads.length) return;
    if (!force && pendingDownloads.length < DOWNLOAD_CHUNK) return;
    const chunk = pendingDownloads.splice(0, pendingDownloads.length);
    // The MV3 service worker may be cold or being swapped; retry with backoff
    // so we never silently drop a batch (especially on the final force flush).
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await chrome.runtime.sendMessage({
          type: "DCMD_DOWNLOAD_BATCH",
          payload: { guildId, channelId, items: chunk },
        });
        state.attachmentsQueued += chunk.length;
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          // Surface but do not throw \u2014 keep scrape running, log clearly.
          state.lastError = `Failed to forward batch of ${chunk.length} to background after ${maxAttempts} attempts: ${err?.message || err}`;
          // Re-queue so a future flush picks them up.
          pendingDownloads = chunk.concat(pendingDownloads);
          return;
        }
        await sleep(jitter(300 * 2 ** (attempt - 1)));
      }
    }
  };

  try {
    while (!state.abortRequested) {
      // throttle
      const sinceLast = Date.now() - lastRequestAt;
      if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
        await sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
      }
      lastRequestAt = Date.now();

      const messages = await fetchMessagesPage({ channelId, before });
      if (!Array.isArray(messages) || messages.length === 0) {
        break; // reached the start of the channel
      }

      for (const m of messages) {
        if (seenMessageIds.has(m.id)) continue;
        seenMessageIds.add(m.id);
        state.messagesScanned += 1;

        if (Array.isArray(m.attachments)) {
          for (const att of m.attachments) {
            if (!att || !att.url || !att.id) continue;
            if (seenAttachmentIds.has(att.id)) continue;
            const kind = classifyAttachment(att);
            if (!kind) continue;
            const rawName = att.filename || `${att.id}`;
            const sec = analyzeFilenameSecurity(rawName);
            if (!sec.ok) {
              seenAttachmentIds.add(att.id);
              state.attachmentsSkippedSecurity += 1;
              console.warn("[DCMD] skipped attachment", att.id, sec.reason, rawName);
              continue;
            }
            seenAttachmentIds.add(att.id);
            state.attachmentsFound += 1;
            pendingDownloads.push({
              id: att.id,
              messageId: m.id,
              url: att.url,
              filename: sec.cleaned,
              size: att.size || 0,
              kind,
              contentType: att.content_type || "",
              authorId: m.author?.id || null,
              timestamp: m.timestamp || null,
            });
          }
        }
      }

      // Update "oldest" pointer (Discord returns newest-first, so the last
      // element of the page is the oldest of the batch).
      const oldestInPage = messages[messages.length - 1]?.id;
      if (oldestInPage) {
        state.oldestMessageId = oldestInPage;
        before = oldestInPage;
      }

      await flush(false);
      await persistStatus();
      broadcastProgress();

      if (messages.length < PAGE_SIZE) {
        break; // last page
      }
    }

    await flush(true);
  } finally {
    // Best-effort final drain in case flush re-queued items after a transient
    // service-worker outage. Bounded \u2014 don't block teardown indefinitely.
    for (let i = 0; i < 3 && pendingDownloads.length; i += 1) {
      await sleep(500);
      await flush(true);
    }
    state.isRunning = false;
    state.finishedAt = Date.now();
    state.abortRequested = false;
    await persistStatus();
    broadcastProgress();
  }
}

// ---------- bootstrap ------------------------------------------------------

(function bootstrap() {
  const { guildId, channelId } = parseChannelFromUrl(location.href);
  state.guildId = guildId;
  state.channelId = channelId;
  chrome.storage.local.set({
    [STORAGE_KEYS.channel]: { guildId, channelId, url: location.href },
  }).catch(() => {});
})();
