import type { IconifyJSON } from "@iconify/types";
import type { ReadmeGlyphs } from "./files";
import type { GlyphBody } from "./shelf";

/**
 * A glyph lookup over an Iconify set (the installed Material Symbols, read by
 * the caller: core does no I/O). Throws on a name the set lacks — an app whose
 * icon cannot be drawn is a broken shelf, never a blank tile.
 */
export function glyphsFrom(set: IconifyJSON): GlyphBody {
  return (name) => {
    const icon = set.icons[name];
    if (!icon) throw new Error(`The icon set has no "${name}" glyph.`);
    return icon.body;
  };
}

/** The icon sets the README draws from, by package — the caller's reader (core does no I/O). */
export function readmeGlyphs(
  read: (
    pkg: "@iconify-json/material-symbols" | "@iconify-json/simple-icons",
  ) => IconifyJSON,
): ReadmeGlyphs {
  return {
    symbol: glyphsFrom(read("@iconify-json/material-symbols")),
    brand: glyphsFrom(read("@iconify-json/simple-icons")),
  };
}
