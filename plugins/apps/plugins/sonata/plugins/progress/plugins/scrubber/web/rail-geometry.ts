import type { Extent } from "@plugins/primitives/plugins/css/plugins/coords/web";

/**
 * Geometry of the progression rail — the single source of truth for where the
 * rail sits vertically. The scrubber draws the rail; any marker drawing a
 * vertical element *on* the rail (bar notches, key-change lines, loop handles)
 * places itself with `RAIL_BAND_Y` / `railBand()` so every on-rail mark shares
 * one vertical band and stays pixel-aligned with the rail and with each other.
 *
 * The rail thickens on hover/drag. Rather than every marker tracking that
 * state, the thickness is a CSS custom property the scrubber sets on the
 * slider (`RAIL_THICKNESS_VAR`: 6px at rest, 10px hot), and the extents below
 * are written against it — so every on-rail mark follows the thickening with
 * no React state and no per-marker code.
 */

/** The custom property holding the rail's current thickness. */
export const RAIL_THICKNESS_VAR = "--sonata-rail-h";
/** Rail thickness at rest and while hovered/dragged. */
export const RAIL_REST = "6px";
export const RAIL_HOT = "10px";

/** Rail thickness, as a LENGTH (follows hover). */
export const RAIL_HEIGHT = `var(${RAIL_THICKNESS_VAR}, ${RAIL_REST})`;

/**
 * The vertical extent that makes a placed box exactly cover the rail's band:
 * centered on the zone's mid-line, rail-height tall. Pair it with whatever
 * horizontal extent the mark wants, e.g.
 * `<Placed x={{ center: pct(f), size: 1 }} y={RAIL_BAND_Y} />`.
 */
export const RAIL_BAND_Y: Extent = { center: "50%", size: RAIL_HEIGHT };

/**
 * The rail band at its HOT thickness plus `outset` px above and below — a
 * fixed extent for marks that should stand a little proud of the rail (key
 * change lines, loop handles) without moving when the rail thickens.
 */
export function railBand(outset: number): Extent {
  return { center: "50%", size: `calc(${RAIL_HOT} + ${outset * 2}px)` };
}

/** Height of the rail zone (the slider's interactive band). */
export const ZONE_HEIGHT = "1rem";
/** Height of the label lane under the rail (13px). */
export const LABEL_LANE_HEIGHT = "0.8125rem";
