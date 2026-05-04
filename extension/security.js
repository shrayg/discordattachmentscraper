/**
 * Filename safety for Discord attachment downloads.
 * Shared by content.js (pre-filter) and background.js (defense in depth).
 */

// Unicode tricks used to spoof file types in Explorer / file managers.
const DANGEROUS_UNICODE = /[\u202E\u202D\u200E\u200F\u200B-\u200D\uFEFF]/g;

// Executable / script / installer extensions commonly abused via Discord.
// Intentionally excludes .jar (common for legitimate game/mod uploads).
const BLOCKED_EXTENSIONS = new Set([
  "exe", "scr", "pif", "bat", "cmd", "com", "cpl", "msi", "msp", "msc",
  "dll", "drv", "sys", "ocx", "hta", "reg", "inf", "ins", "isp", "scf",
  "lnk", "url", "wsh", "ws", "wsf", "wsc", "sct", "shb", "shs", "website",
  "js", "jse", "vbs", "vbe", "vb", "vsmacros",
  "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psm1", "psd1",
  "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
  "sh", "bash", "zsh", "fish", "ksh", "csh", "tcsh",
  "py", "pyw", "pyz", "pyc", "pyo", "rb", "pl", "pm", "php", "phar",
  "asp", "asa", "cer", "crt", "der", "app", "application", "gadget",
  "ade", "adp", "bas", "chm", "fxp", "hlp", "hpj", "its", "xbap", "xnk",
  "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw",
  "mda", "mdb", "mde", "mdt", "mdw", "mdz", "ops", "osd", "pcd", "plg",
  "prf", "prg", "printerexport", "pst", "tmp",
]);

// "document.jpg.exe" — benign-looking suffix, dangerous true type at end.
const SPOOF_BENIGN_THEN_DANGEROUS =
  /\.(jpe?g|png|gif|webp|bmp|tiff?|svg|ico|heic|avif|pdf|txt|docx?|xlsx?|pptx?|rtf|csv|od[tpst]|zip|rar|7z|tar|gz|tgz)\.(exe|scr|pif|bat|cmd|com|js|jse|vbs|vbe|ps1|psm1|hta|cpl|msi|msp|msc|lnk|dll|wsf|wsh|sh|bash|zsh|fish)$/i;

// "malware.exe.jpg" — executable type hidden before a fake image extension.
const SPOOF_DANGEROUS_THEN_IMAGE =
  /\.(exe|scr|pif|bat|cmd|com|js|jse|vbs|vbe|ps1|psm1|hta|cpl|msi|msp|msc|lnk|dll|wsf|wsh)\.(jpe?g|png|gif|webp|bmp|pdf|txt|docx?)$/i;

/**
 * Remove RTLO / zero-width characters attackers embed in filenames.
 * @param {string} s
 * @returns {string}
 */
export function stripDangerousUnicode(s) {
  return String(s ?? "").replace(DANGEROUS_UNICODE, "");
}

/**
 * @param {string} rawFilename
 * @returns {{ ok: boolean, reason?: string, cleaned: string }}
 */
export function analyzeFilenameSecurity(rawFilename) {
  let cleaned = stripDangerousUnicode(String(rawFilename ?? ""));
  // Strip path segments if a path ever slipped through.
  cleaned = cleaned.replace(/\\/g, "/");
  const slash = cleaned.lastIndexOf("/");
  if (slash >= 0) cleaned = cleaned.slice(slash + 1);
  // NTFS alternate-data-stream marker: "evil.exe:Zone.Identifier"
  const colon = cleaned.indexOf(":");
  if (colon >= 0) cleaned = cleaned.slice(0, colon);
  cleaned = cleaned.replace(/^\.+/, "").trim();
  // Windows trailing-dot/space normalization — trim for analysis.
  cleaned = cleaned.replace(/[.\u00A0\s]+$/g, "").trim();

  if (!cleaned) {
    return { ok: false, reason: "empty filename after sanitization", cleaned: "unknown" };
  }

  if (SPOOF_BENIGN_THEN_DANGEROUS.test(cleaned)) {
    return {
      ok: false,
      reason: "blocked double-extension spoof (benign name + dangerous type)",
      cleaned,
    };
  }
  if (SPOOF_DANGEROUS_THEN_IMAGE.test(cleaned)) {
    return {
      ok: false,
      reason: "blocked double-extension spoof (hidden executable + fake image/doc)",
      cleaned,
    };
  }

  const dot = cleaned.lastIndexOf(".");
  const ext = dot >= 0 ? cleaned.slice(dot + 1).toLowerCase() : "";
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: `blocked dangerous extension ".${ext}"`,
      cleaned,
    };
  }

  // Any middle segment that is exactly a blocked extension (e.g. "setup.exe.zip"
  // where last is zip — zip allowed; but "evil.exe.png" last png — caught by SPOOF_DANGEROUS_THEN_IMAGE)
  // Catch "archive.tar.exe" style: last ext exe already caught.

  return { ok: true, cleaned };
}
