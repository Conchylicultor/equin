/**
 * The palette app tiles are painted from — the `--categorical-*` values every
 * launcher (the Home gallery, the app-launcher grid) draws its squircles in, so
 * an app's tile is the same colour wherever it is launched from.
 *
 * The ocean band: slots 1–9 walk the hue from teal (175) toward violet in 17°
 * steps at one quiet chroma, alternating lightness 0.50 / 0.57 so neighbours
 * separate; a tile's second shade adds 0.13 on top (the avatar primitive's
 * rule). Slot 10 is the neutral slate an app can ask for by name (Settings).
 *
 * The same in both modes: a tile is its fill (lit from above) under a white glyph, which
 * needs this lightness whatever the page behind it.
 */
export const APP_TILE_PALETTE = {
  "categorical-1": "oklch(0.50 0.11 175)",
  "categorical-2": "oklch(0.57 0.11 192)",
  "categorical-3": "oklch(0.50 0.11 209)",
  "categorical-4": "oklch(0.57 0.11 226)",
  "categorical-5": "oklch(0.50 0.11 243)",
  "categorical-6": "oklch(0.57 0.11 260)",
  "categorical-7": "oklch(0.50 0.11 277)",
  "categorical-8": "oklch(0.57 0.11 294)",
  "categorical-9": "oklch(0.50 0.11 311)",
  "categorical-10": "oklch(0.48 0.02 250)",
} as const;
