import type { StallClient } from "./main-thread-stall-kind";

/**
 * The browser family and OS a user agent string names — nothing finer (no
 * version, no device): a stall report says which kind of browser froze, never
 * which visitor. PURE (the caller passes `navigator.userAgent`). Order
 * matters: Chromium forks and webviews also say "Chrome", iOS browsers all say
 * "Safari", and Chrome's desktop-site mode on iOS says "Macintosh".
 */
export function coarseClient(ua: string): StallClient {
  if (!ua) return { family: "unknown", os: "unknown" };
  const os: StallClient["os"] = /iPhone|iPad|iPod/.test(ua)
    ? "ios"
    : /Android/.test(ua)
      ? "android"
      : /CrOS/.test(ua)
        ? "chromeos"
        : /Windows/.test(ua)
          ? "windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "macos"
            : /Linux|X11/.test(ua)
              ? "linux"
              : "other";
  const family: StallClient["family"] = /SamsungBrowser\//.test(ua)
    ? "samsung"
    : /EdgA?\/|EdgiOS\//.test(ua)
      ? "edge"
      : /OPR\/|OPiOS\//.test(ua)
        ? "opera"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "firefox"
          : // An Android WebView marks itself `; wv)`.
            os === "android" && /; wv\)/.test(ua)
            ? "webview"
            : /Chrome\/|CriOS\//.test(ua)
              ? "chrome"
              : /Safari\//.test(ua)
                ? "safari"
                : // An iOS in-app view has no Safari/ token.
                  os === "ios" && /AppleWebKit\//.test(ua)
                  ? "webview"
                  : "other";
  return { family, os };
}
