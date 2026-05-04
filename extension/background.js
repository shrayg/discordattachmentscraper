import { analyzeFilenameSecurity, stripDangerousUnicode } from "./security.js";

// MV3 service worker. Receives batched download requests from the content
// script and saves attachments to disk via chrome.downloads with a stable,
// safe folder layout. Maintains a per-installation deduplication set so that
// re-running a scrape does not re-download the same attachment IDs.
//
// Folder layout (relative to the user's Chrome download dir):
//   DiscordMedia/<guildId>/<channelId>/<attachmentId>__<safeFilename>
//
// Why prepend the attachment ID? Discord allows duplicate filenames inside a
// channel, and attachment IDs are globally unique snowflakes; the prefix is a
// natural primary key + dedupe key.

const ROOT_FOLDER = "DiscordMedia";
const SEEN_KEY = "dcmd_downloaded_ids";
const MAX_CONCURRENT_DOWNLOADS = 4;

let inFlight = 0;
const queue = [];
let seenIds = null; // Set, lazy-loaded

async function loadSeen() {
  if (seenIds) return seenIds;
  try {
    const stored = await chrome.storage.local.get(SEEN_KEY);
    const arr = Array.isArray(stored[SEEN_KEY]) ? stored[SEEN_KEY] : [];
    seenIds = new Set(arr);
  } catch {
    seenIds = new Set();
  }
  return seenIds;
}

let persistTimer = null;
function schedulePersistSeen() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.local.set({ [SEEN_KEY]: Array.from(seenIds) });
    } catch (_) {}
  }, 1000);
}

// Strip characters that are illegal on Windows / weird elsewhere.
// Also collapse whitespace and limit length to keep downloads.download happy.
function sanitizeSegment(s, maxLen = 120) {
  let out = stripDangerousUnicode(String(s ?? ""))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) out = "unknown";
  if (out.length > maxLen) {
    // Preserve the file extension when we truncate.
    const dot = out.lastIndexOf(".");
    if (dot > 0 && out.length - dot <= 12) {
      const ext = out.slice(dot);
      out = out.slice(0, maxLen - ext.length) + ext;
    } else {
      out = out.slice(0, maxLen);
    }
  }
  return out;
}

function buildFilename({ guildId, channelId, item }) {
  const guild = sanitizeSegment(guildId || "dm", 40);
  const channel = sanitizeSegment(channelId, 40);
  const fname = sanitizeSegment(`${item.id}__${item.filename}`, 180);
  return `${ROOT_FOLDER}/${guild}/${channel}/${fname}`;
}

function pump() {
  while (inFlight < MAX_CONCURRENT_DOWNLOADS && queue.length) {
    const job = queue.shift();
    inFlight += 1;
    chrome.downloads.download(
      {
        url: job.url,
        filename: job.filename,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        inFlight -= 1;
        const err = chrome.runtime.lastError;
        if (err || downloadId === undefined) {
          // Don't mark as seen on hard failure so a re-run can retry.
          console.warn("[DCMD] download failed", job.url, err?.message);
        } else {
          seenIds.add(job.id);
          schedulePersistSeen();
        }
        pump();
      }
    );
  }
}

async function enqueueBatch({ guildId, channelId, items }) {
  await loadSeen();
  let added = 0;
  let skipped = 0;
  let skippedSecurity = 0;
  for (const item of items) {
    if (!item?.url || !item?.id) {
      skipped += 1;
      continue;
    }
    if (seenIds.has(item.id)) {
      skipped += 1;
      continue;
    }
    const sec = analyzeFilenameSecurity(item.filename || String(item.id));
    if (!sec.ok) {
      skippedSecurity += 1;
      console.warn("[DCMD] background security skip", item.id, sec.reason);
      continue;
    }
    const safeItem = { ...item, filename: sec.cleaned };
    queue.push({
      id: item.id,
      url: item.url,
      filename: buildFilename({ guildId, channelId, item: safeItem }),
    });
    added += 1;
  }
  pump();
  return { added, skipped, skippedSecurity, queueDepth: queue.length, inFlight };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "DCMD_DOWNLOAD_BATCH") {
    enqueueBatch(msg.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true; // async
  }

  if (msg.type === "DCMD_RESET_DEDUPE") {
    chrome.storage.local.remove(SEEN_KEY).then(() => {
      seenIds = new Set();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "DCMD_GET_QUEUE_STATUS") {
    sendResponse({
      ok: true,
      queueDepth: queue.length,
      inFlight,
      seenCount: seenIds ? seenIds.size : null,
    });
    return true;
  }
});

// Re-broadcast progress events from content scripts so the popup can subscribe
// from a single place.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "DCMD_PROGRESS") {
    // chrome.runtime.sendMessage with no recipient broadcasts to all extension
    // pages (including the popup). The popup listens for this event.
    // No-op pass-through; popup already receives it.
  }
});
