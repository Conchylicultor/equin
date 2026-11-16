/**
 * The README images' shared look. They are shown through GitHub's `<img>`:
 * no script, no web font, no interaction — only what the SVG file holds, CSS
 * animations included. One look for both GitHub themes: every image is its
 * own dark card (or reads on either background).
 */
export const INK = {
  bg: "#0d1117",
  card: "#161b22",
  border: "#30363d",
  fg: "#e6edf3",
  muted: "#8b949e",
} as const;

export const FONT = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;`;

/** Stops every CSS animation for a reader who asked for less motion. */
export const REDUCED_MOTION = `@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; } }`;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function f1(n: number): string {
  return n.toFixed(1);
}
