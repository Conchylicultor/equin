/**
 * The browser floor: the oldest browser of each engine equin's browser code
 * runs on. Every built-in a browser-built file uses must exist in all of them
 * — `no-api-above-floor` holds it, against MDN's browser-compat-data.
 *
 * Chosen as "every browser from March 2023 on": Chrome / Edge 111, Safari
 * 16.4 — and Firefox 115, its extended-support release of that summer, the
 * oldest Firefox still shipped to anyone. It keeps iOS 16 (the last iOS of the iPhone 8 and X, still
 * updated to 16.7) — the public website's visitors include phones stuck there,
 * and one crashed on `URL.canParse` (Safari 17) on 2026-11-19. It sits at or
 * above vite's default build target (`baseline-widely-available`: Chrome 107,
 * Safari 16), so the syntax the build emits already runs everywhere the floor
 * does; this floor is about the APIs, which no build step lowers.
 *
 * Keys are browser-compat-data browser ids; values its version spelling.
 */
export const BROWSER_FLOOR = {
  chrome: "111",
  chrome_android: "111",
  edge: "111",
  firefox: "115",
  firefox_android: "115",
  safari: "16.4",
  safari_ios: "16.4",
} as const satisfies Readonly<Record<string, string>>;

export type FloorBrowser = keyof typeof BROWSER_FLOOR;

/** How a floor browser is named in a message. */
export const BROWSER_LABEL: Readonly<Record<FloorBrowser, string>> = {
  chrome: "Chrome",
  chrome_android: "Chrome Android",
  edge: "Edge",
  firefox: "Firefox",
  firefox_android: "Firefox Android",
  safari: "Safari",
  safari_ios: "iOS Safari",
};

/** The floor in words: `Chrome 111, Edge 111, …`. */
export function floorInWords(): string {
  return (Object.keys(BROWSER_FLOOR) as FloorBrowser[])
    .map((b) => `${BROWSER_LABEL[b]} ${BROWSER_FLOOR[b]}`)
    .join(", ");
}
