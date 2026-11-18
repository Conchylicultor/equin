/**
 * The README images' shared look. They are shown through GitHub's `<img>`:
 * no script, no web font, no interaction — only what the SVG file holds, CSS
 * animations included. The big cards (hero, demo) are their own dark card on
 * either GitHub theme; what sits on the page itself (the shelf's labels, the
 * link pills) is drawn once per theme, and README.md picks one with
 * `<picture>` + `prefers-color-scheme`.
 */
export type Theme = "dark" | "light";

/** GitHub's own page colours, per theme. */
export const INKS = {
  dark: {
    bg: "#0d1117",
    card: "#161b22",
    border: "#30363d",
    fg: "#e6edf3",
    muted: "#8b949e",
    link: "#4493f8",
    green: "#3fb950",
  },
  light: {
    bg: "#ffffff",
    card: "#f6f8fa",
    border: "#d0d7de",
    fg: "#1f2328",
    muted: "#59636e",
    link: "#0969da",
    green: "#1a7f37",
  },
} as const satisfies Record<Theme, Record<string, string>>;

/** The dark look, which the cards (hero, demo) wear on both themes. */
export const INK = INKS.dark;

/** A file name's theme suffix: the dark file keeps the bare name, the light one ends `-light`. */
export function themeSuffix(theme: Theme): string {
  return theme === "dark" ? "" : "-light";
}

export const FONT = `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;`;

/** Stops every CSS animation for a reader who asked for less motion. */
export const REDUCED_MOTION = `@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; } }`;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function f1(n: number): string {
  return n.toFixed(1);
}
