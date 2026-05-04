// Popup UI controller. Stateless re: scrape orchestration; the content script
// in the active discord.com tab is the source of truth. We poll it for state
// and also subscribe to broadcast progress updates from runtime.onMessage.

const els = {
  tabUrl: document.getElementById("tabUrl"),
  guildId: document.getElementById("guildId"),
  channelId: document.getElementById("channelId"),
  authStatus: document.getElementById("authStatus"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  hint: document.getElementById("hint"),
  progressCard: document.getElementById("progressCard"),
  runStatus: document.getElementById("runStatus"),
  msgCount: document.getElementById("msgCount"),
  foundCount: document.getElementById("foundCount"),
  skippedSecurityCount: document.getElementById("skippedSecurityCount"),
  queuedCount: document.getElementById("queuedCount"),
  oldestId: document.getElementById("oldestId"),
  elapsed: document.getElementById("elapsed"),
  errorBox: document.getElementById("errorBox"),
  resetBtn: document.getElementById("resetDedupeBtn"),
};

let activeTabId = null;
let elapsedTimer = null;
let lastStartedAt = 0;

function fmtElapsed(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function shortId(id, head = 4, tail = 4) {
  if (!id) return "—";
  const s = String(id);
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const DISCORD_APP_PREFIXES = [
  "https://discord.com/",
  "https://canary.discord.com/",
  "https://ptb.discord.com/",
];

function isDiscordAppUrl(url) {
  if (!url) return false;
  return DISCORD_APP_PREFIXES.some((p) => url.startsWith(p));
}

function tabPathForDisplay(url) {
  // Strip origin so TAB row shows "/channels/..." regardless of host.
  return url.replace(/^https:\/\/[^/]+/, "");
}

async function getActiveDiscordTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !isDiscordAppUrl(tab.url)) return null;
  return tab;
}

async function refresh() {
  const tab = await getActiveDiscordTab();
  if (!tab) {
    els.tabUrl.textContent = "Not on Discord (app)";
    els.guildId.textContent = "—";
    els.channelId.textContent = "—";
    els.authStatus.textContent = "—";
    els.startBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.hint.textContent =
      "Open Discord in this tab (discord.com, canary, or PTB) and navigate into a channel.";
    return;
  }
  activeTabId = tab.id;
  els.tabUrl.textContent = tabPathForDisplay(tab.url);

  let state;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: "DCMD_GET_STATE" });
  } catch (err) {
    els.guildId.textContent = "—";
    els.channelId.textContent = "—";
    els.authStatus.textContent = "—";
    els.startBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.hint.textContent = "Could not reach the page script. Reload the Discord tab and try again.";
    return;
  }

  els.guildId.textContent = state.guildId ? shortId(state.guildId, 6, 4) : "—";
  els.channelId.textContent = state.channelId ? shortId(state.channelId, 6, 4) : "—";
  els.authStatus.textContent = state.hasAuth ? "Yes" : "No";

  const canStart =
    !state.isRunning && state.hasAuth && !!state.channelId;
  els.startBtn.disabled = !canStart;
  els.stopBtn.disabled = !state.isRunning;

  if (!state.hasAuth) {
    els.hint.textContent =
      "Auth not captured yet. Click on a channel in Discord to make the client send a request, then reopen this popup.";
  } else if (!state.channelId) {
    els.hint.textContent =
      "No channel detected in URL. Open a channel (URL must look like /channels/<server>/<channel>).";
  } else if (state.isRunning) {
    els.hint.textContent = "Running. You can close this popup; the scrape continues in the tab.";
  } else {
    els.hint.textContent = "Ready. Files save to ~/Downloads/DiscordMedia/<server>/<channel>/.";
  }

  applyProgress(state);
}

function applyProgress(p) {
  if (!p) return;
  const showCard =
    p.isRunning ||
    p.messagesScanned > 0 ||
    p.lastError ||
    (p.attachmentsSkippedSecurity ?? 0) > 0;
  els.progressCard.hidden = !showCard;
  if (!showCard) return;

  els.runStatus.textContent = p.isRunning
    ? "running"
    : p.lastError
    ? "error"
    : p.finishedAt
    ? "done"
    : "idle";
  els.msgCount.textContent = String(p.messagesScanned ?? 0);
  els.foundCount.textContent = String(p.attachmentsFound ?? 0);
  els.skippedSecurityCount.textContent = String(p.attachmentsSkippedSecurity ?? 0);
  els.queuedCount.textContent = String(p.attachmentsQueued ?? 0);
  els.oldestId.textContent = p.oldestMessageId ? shortId(p.oldestMessageId, 6, 4) : "—";

  lastStartedAt = p.startedAt || 0;
  const end = p.isRunning ? Date.now() : (p.finishedAt || Date.now());
  els.elapsed.textContent = fmtElapsed(lastStartedAt ? end - lastStartedAt : 0);

  if (p.lastError) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = p.lastError;
  } else {
    els.errorBox.hidden = true;
    els.errorBox.textContent = "";
  }

  if (p.isRunning && !elapsedTimer) {
    elapsedTimer = setInterval(() => {
      if (!lastStartedAt) return;
      els.elapsed.textContent = fmtElapsed(Date.now() - lastStartedAt);
    }, 1000);
  } else if (!p.isRunning && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  els.startBtn.disabled = p.isRunning || !p.channelId;
  els.stopBtn.disabled = !p.isRunning;
}

// Subscribe to live progress broadcasts from the content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "DCMD_PROGRESS") {
    applyProgress(msg.payload);
  }
});

els.startBtn.addEventListener("click", async () => {
  if (!activeTabId) return;
  els.startBtn.disabled = true;
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, { type: "DCMD_START" });
    if (!res?.ok) {
      els.errorBox.hidden = false;
      els.errorBox.textContent = res?.error || "Failed to start.";
      els.progressCard.hidden = false;
      els.startBtn.disabled = false;
    }
  } catch (err) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = err.message || String(err);
    els.progressCard.hidden = false;
    els.startBtn.disabled = false;
  }
  refresh();
});

els.stopBtn.addEventListener("click", async () => {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "DCMD_STOP" });
  } catch (_) {}
  refresh();
});

els.resetBtn.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "DCMD_RESET_DEDUPE" });
    els.resetBtn.textContent = "Cleared \u2713";
    setTimeout(() => (els.resetBtn.textContent = "Reset download dedupe cache"), 1500);
  } catch (err) {
    els.errorBox.hidden = false;
    els.errorBox.textContent = err.message || String(err);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  refresh();
  // Light periodic refresh for cases where the content script can't broadcast
  // (e.g., race during initial load).
  setInterval(refresh, 2000);
});
