import { demoSvg } from "./demo";
import { heroSvg } from "./hero";
import { PILLS, pillSvg } from "./pills";
import { shelfSvg, type GlyphBody } from "./shelf";
import { themeSuffix, type Theme } from "./style";

/** Where the README's images live, repo-relative (README.md links them). */
export const README_ASSET_DIR = "docs/readme";

/** The icon sets the README's images draw from, read by the caller (core does no I/O). */
export interface ReadmeGlyphs {
  /** Material Symbols. */
  symbol: GlyphBody;
  /** Simple Icons (brand marks). */
  brand: GlyphBody;
}

const THEMES: readonly Theme[] = ["dark", "light"];

/**
 * Every image the repo README shows, as data: its path and how it is drawn.
 * Written by `scripts/render.ts`, held equal to what this renders by the
 * `readme:files-in-sync` check. What sits on the page (the shelf, the pills)
 * is one file per theme; README.md picks one with `<picture>`.
 */
export const README_FILES: readonly {
  path: string;
  render: (glyphs: ReadmeGlyphs) => string;
}[] = [
  { path: `${README_ASSET_DIR}/hero.svg`, render: () => heroSvg() },
  ...THEMES.map((theme) => ({
    path: `${README_ASSET_DIR}/apps${themeSuffix(theme)}.svg`,
    render: (glyphs: ReadmeGlyphs) => shelfSvg(glyphs.symbol, theme),
  })),
  ...PILLS.flatMap((pill) =>
    THEMES.map((theme) => ({
      path: `${README_ASSET_DIR}/pill-${pill.id}${themeSuffix(theme)}.svg`,
      render: (glyphs: ReadmeGlyphs) => pillSvg(pill, theme, glyphs),
    })),
  ),
  { path: `${README_ASSET_DIR}/demo.svg`, render: () => demoSvg() },
];
