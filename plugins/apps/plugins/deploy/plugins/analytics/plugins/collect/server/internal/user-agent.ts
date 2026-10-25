import type { BrowserFamily, DeviceFamily, OsFamily } from "../../core";

/**
 * A user agent reduced to three closed families. Hand-rolled on purpose: the
 * families are coarse, the list is closed, and a dependency would ship a
 * database of versions this never stores. The full string is used in memory
 * only and never persisted.
 *
 * Order matters in each ladder: Chromium derivatives all say "Chrome" and
 * "Safari", and iOS browsers all say "Safari" — so the specific tokens are
 * tested before the generic ones.
 */
export interface UserAgentFamilies {
  device: DeviceFamily;
  browser: BrowserFamily;
  os: OsFamily;
}

export function parseUserAgent(ua: string): UserAgentFamilies {
  return { device: deviceOf(ua), browser: browserOf(ua), os: osOf(ua) };
}

function browserOf(ua: string): BrowserFamily {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\b(OPR|Opera|OPiOS)\//.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\b(Firefox|FxiOS)\//.test(ua)) return "Firefox";
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return "Chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return "Safari";
  // iOS in-app webviews (no Version/ token) are WebKit, i.e. Safari's engine.
  if (/\b(iPhone|iPad|iPod)\b/.test(ua) && /AppleWebKit\//.test(ua)) {
    return "Safari";
  }
  return "Other";
}

function osOf(ua: string): OsFamily {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\b(Macintosh|Mac OS X)\b/.test(ua)) return "macOS";
  if (/\b(Linux|X11)\b/.test(ua)) return "Linux";
  return "Other";
}

function deviceOf(ua: string): DeviceFamily {
  if (/\biPad\b/.test(ua) || /\bTablet\b/i.test(ua)) return "Tablet";
  // Android phones say "Mobile"; Android tablets do not.
  if (/\bAndroid\b/.test(ua))
    return /\bMobile\b/.test(ua) ? "Mobile" : "Tablet";
  if (/\b(iPhone|iPod|Mobi|Windows Phone)\b/.test(ua)) return "Mobile";
  return "Desktop";
}
