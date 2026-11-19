/**
 * The browser and the system it says it runs on, read from a user agent string
 * for a bug report: `Chrome 142 on macOS`. Hand-rolled on purpose — a coarse
 * name and a major version is all an issue needs, and a parsing library would
 * ship a database of versions for that.
 *
 * Order matters: Chromium derivatives all say "Chrome" and "Safari", and iOS
 * browsers all say "Safari", so the specific tokens are tested first.
 */
export function describeBrowser(ua: string): string {
  const os = systemOf(ua);
  return `${browserOf(ua)}${os === null ? "" : ` on ${os}`}`;
}

const BROWSERS: readonly (readonly [name: string, token: RegExp])[] = [
  ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /\b(?:OPR|OPiOS)\/(\d+)/],
  ["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
  ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /\b(?:HeadlessChrome|Chrome|CriOS|Chromium)\/(\d+)/],
  ["Safari", /\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//],
];

function browserOf(ua: string): string {
  for (const [name, token] of BROWSERS) {
    const match = token.exec(ua);
    if (match !== null) return `${name} ${match[1]}`;
  }
  return "Unknown browser";
}

function systemOf(ua: string): string | null {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\b(Macintosh|Mac OS X)\b/.test(ua)) return "macOS";
  if (/\b(Linux|X11)\b/.test(ua)) return "Linux";
  return null;
}
