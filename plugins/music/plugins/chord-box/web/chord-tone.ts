import type React from "react";
import type { ScaleDegree } from "../core";
import "./chord-box.css";

/**
 * How deep each degree's solid tile is: the share of the chord colour kept
 * when it is mixed toward black in OKLCH (degrees 1 … 7, the tonic first). Each hue is deepened until
 * the light numeral on it reads, gold least of all.
 */
const TILE_DEPTH = ["76%", "70%", "76%", "72%", "74%", "76%", "72%"] as const;

/** A root outside the scale: the palette's neutral chord grey. */
const OUTSIDE_SCALE = { colour: "var(--chord-outside)", depth: "74%" };

/**
 * A degree's chord colour as a CSS value: `var(--chord-1)` … `var(--chord-7)`
 * (degrees 1 … 7, the tonic first), or `var(--chord-outside)` for `null`, a root outside the scale.
 */
export function chordColour(degree: ScaleDegree | null): string {
  return degree === null
    ? OUTSIDE_SCALE.colour
    : `var(--chord-${String(degree + 1)})`;
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
    "--fn-depth": degree === null ? OUTSIDE_SCALE.depth : TILE_DEPTH[degree],
  } as React.CSSProperties;
}
