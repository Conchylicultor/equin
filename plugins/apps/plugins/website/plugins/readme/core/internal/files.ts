import { demoSvg } from "./demo";
import { heroSvg } from "./hero";
import { shelfSvg, type GlyphBody } from "./shelf";

/** Where the README's images live, repo-relative (README.md links them). */
export const README_ASSET_DIR = "docs/readme";

/**
 * Every image the repo README shows, as data: its path and how it is drawn.
 * Written by `scripts/render.ts`, held equal to what this renders by the
 * `readme:files-in-sync` check.
 */
export const README_FILES: readonly {
  path: string;
  render: (glyph: GlyphBody) => string;
}[] = [
  { path: `${README_ASSET_DIR}/hero.svg`, render: () => heroSvg() },
  { path: `${README_ASSET_DIR}/apps.svg`, render: (glyph) => shelfSvg(glyph) },
  { path: `${README_ASSET_DIR}/demo.svg`, render: () => demoSvg() },
];
