import type React from "react";
import type { ScaleDegree } from "../core";
import "./chord-box.css";

/**
 * How deep each degree's solid tile is: the share of the chord colour kept
 * when it is mixed toward black in OKLCH (I … VII). Each hue is deepened until
 * the light numeral on it reads, gold least of all.
 */
const TILE_DEPTH = ["76%", "70%", "76%", "72%", "74%", "76%", "72%"] as const;

/** No key to read the root against: the palette's neutral chord grey. */
const NO_KEY = { colour: "var(--chord-outside)", depth: "74%" };

/**
 * A degree's chord colour as a CSS value: `var(--chord-1)` … `var(--chord-7)`
 * (I … VII, by the numeral's number: ♭VII is VII's colour), or
 * `var(--chord-outside)` for `null`, a chord with no key.
 */
export function chordColour(degree: ScaleDegree | null): string {
  return degree === null ? NO_KEY.colour : `var(--chord-${String(degree + 1)})`;
}

/**
 * The CSS custom properties that paint a chord: `--fn` (its degree's colour,
 * {@link chordColour}) and `--fn-depth` (how deep its tile is). `.chord-tone`
 * in `chord-box.css` derives the tile fill (`--fn-bg`) and the numeral on it
 * (`--fn-ink`) from these.
 */
export function chordToneStyle(
  degree: ScaleDegree | null,
): React.CSSProperties {
  return {
    "--fn": chordColour(degree),
    "--fn-depth": degree === null ? NO_KEY.depth : TILE_DEPTH[degree],
  } as React.CSSProperties;
}
