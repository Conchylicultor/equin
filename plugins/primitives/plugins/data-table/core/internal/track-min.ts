/**
 * The narrowest a column gets before the table scrolls sideways, read from its
 * grid track (`ColumnDef.width`): a definite length counts as itself and
 * `minmax(a, b)` as `a`. A content- or space-sized track — `auto`,
 * `max-content`, an `fr`, `minmax(0, …)`, a percentage — has no length to read,
 * so its minimum is measured on the rendered table instead.
 */
export type TrackMin = { kind: "px"; px: number } | { kind: "measured" };

const LENGTH = /^(\d*\.?\d+)(px|rem)$/;

export function trackMin(track: string | undefined, remPx: number): TrackMin {
  const t = (track ?? "auto").trim();
  const floor = t.startsWith("minmax(") ? minmaxFloor(t) : t;
  const m = LENGTH.exec(floor);
  if (!m) return { kind: "measured" };
  const px = parseFloat(m[1]!) * (m[2] === "rem" ? remPx : 1);
  // A zero floor says nothing about the column — it is a flexible track.
  return px > 0 ? { kind: "px", px } : { kind: "measured" };
}

/**
 * The track a grid table lays a column out with: its own, except that a
 * `minmax(0, …)` floor becomes the column's measured header label (`labelPx`,
 * once known). A zero floor lets a flexible column (`minmax(0,1fr)`) collapse to
 * nothing once the table is wider than its box, its label spilling over its
 * neighbours'; floored at its label it keeps a readable sliver and the table
 * scrolls instead. Not `min-content`: a truncating cell's min-content is its
 * whole unwrapped text. This is the floor `trackMin` reads as "measured", so
 * the fit and the layout agree.
 */
export function floorAtLabel(
  track: string | undefined,
  labelPx: number | undefined,
): string {
  const t = (track ?? "auto").trim();
  if (labelPx === undefined || !t.startsWith("minmax(")) return t;
  const floor = minmaxFloor(t);
  if (!/^0(px|rem)?$/.test(floor)) return t;
  const rest = t.slice("minmax(".length + floor.length).replace(/^\s*,\s*/, "");
  return `minmax(${labelPx}px, ${rest}`;
}

/** `minmax(a, b)` → `a` (its first top-level argument). */
function minmaxFloor(track: string): string {
  const inner = track.slice("minmax(".length, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return inner.slice(0, i).trim();
  }
  return inner.trim();
}
