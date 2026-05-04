// Runs in the page's MAIN world at document_start.
// Sole job: passively observe Discord's own outbound API requests so we can
// learn (a) the user's Authorization header and (b) the X-Super-Properties /
// X-Discord-Locale headers Discord ships with every request. We never modify
// the request, never make our own request, and never touch storage from here.
// All captured data is sent to the isolated-world content script via
// window.postMessage with a strict source tag, which it validates.
(() => {
  if (window.__DCMD_INJECTED__) return;
  window.__DCMD_INJECTED__ = true;

  const SRC = "DCMD_PAGE";
  const post = (payload) => {
    try {
      window.postMessage({ __dcmd_src: SRC, ...payload }, window.location.origin);
    } catch (_) {
      // ignore postMessage serialization errors
    }
  };

  const HEADER_KEYS = [
    "authorization",
    "x-super-properties",
    "x-discord-locale",
    "x-discord-timezone",
  ];

  const extractHeaders = (headers) => {
    const out = {};
    if (!headers) return out;
    try {
      if (headers instanceof Headers) {
        for (const k of HEADER_KEYS) {
          const v = headers.get(k);
          if (v) out[k] = v;
        }
      } else if (Array.isArray(headers)) {
        for (const [k, v] of headers) {
          const lk = String(k).toLowerCase();
          if (HEADER_KEYS.includes(lk) && v) out[lk] = String(v);
        }
      } else if (typeof headers === "object") {
        for (const k of Object.keys(headers)) {
          const lk = k.toLowerCase();
          if (HEADER_KEYS.includes(lk) && headers[k]) out[lk] = String(headers[k]);
        }
      }
    } catch (_) {
      // headers may be a frozen / opaque structure; ignore
    }
    return out;
  };

  // ---- patch fetch -----------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/") && url.includes("discord.com")) {
        let headers = init?.headers;
        if (!headers && input instanceof Request) headers = input.headers;
        const captured = extractHeaders(headers);
        if (captured.authorization) {
          post({ type: "auth", headers: captured });
        }
      }
    } catch (_) {
      // never let our hook break the user's app
    }
    return origFetch.apply(this, arguments);
  };

  // ---- patch XMLHttpRequest -------------------------------------------------
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSetHeader = XHR.prototype.setRequestHeader;
  const origSend = XHR.prototype.send;
  XHR.prototype.open = function (method, url) {
    this.__dcmd_url = url;
    this.__dcmd_headers = {};
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    try {
      const lk = String(name).toLowerCase();
      if (HEADER_KEYS.includes(lk)) this.__dcmd_headers[lk] = String(value);
    } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function () {
    try {
      const url = String(this.__dcmd_url || "");
      if (
        url.includes("/api/") &&
        url.includes("discord.com") &&
        this.__dcmd_headers?.authorization
      ) {
        post({ type: "auth", headers: this.__dcmd_headers });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ---- channel context broadcaster -----------------------------------------
  // Push current URL on load + whenever it changes (Discord is a SPA).
  let lastUrl = "";
  const sendUrl = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      post({ type: "url", url: location.href });
    }
  };
  sendUrl();
  // Discord uses pushState; watch it.
  const wrap = (name) => {
    const orig = history[name];
    history[name] = function () {
      const ret = orig.apply(this, arguments);
      queueMicrotask(sendUrl);
      return ret;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", sendUrl);
  // Light polling fallback in case nav happens via mechanisms we missed.
  setInterval(sendUrl, 1500);
})();
