/**
 * The equin logo as data: one ¾ outer arc that folds, after a short straight
 * rise, into bowls hanging just under the circle's centre — each starting where
 * the last one ended, on alternating centres. Everything that draws the logo
 * (the <Logo> component, every generated file) is built from this.
 *
 * Two masters: `full` (three bowls) and `small` (two bowls, a heavier line),
 * because below `smallBelowPx` the third bowl would merge into its neighbours.
 * All numbers are in the 100 × 100 view box.
 */
export const LOGO = {
  center: 50,
  outerRadius: 38,
  /** Where the outer arc starts, in degrees (0 = right, -90 = top, clockwise). */
  arcStartDeg: -90,
  /** How far the bowls' centre line sits above the circle's centre. */
  lift: 4,
  masters: {
    full: { bowls: [29, 20, 11], stroke: 7.8 },
    small: { bowls: [27, 16], stroke: 9 },
  },
  /** Drawn smaller than this many px, the logo uses its small master. */
  smallBelowPx: 28,
  /** Runs from the top-right (blue) to the bottom-left (violet), in view-box units. */
  gradient: { from: "#3b82f6", to: "#8b5cf6", x1: 88, y1: 12, x2: 12, y2: 88 },
} as const;

export type LogoMaster = keyof typeof LOGO.masters;

export function logoStroke(master: LogoMaster): number {
  return LOGO.masters[master].stroke;
}

/** Up to two decimals, no trailing zeros — the paths stay readable. */
export function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function pointAt(deg: number): readonly [number, number] {
  const { center: c, outerRadius: r } = LOGO;
  const a = (deg * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/**
 * The logo's one path: the outer arc from `startDeg` clockwise to the circle's
 * leftmost point, the straight rise of `lift`, then the master's bowls.
 */
export function logoPath(
  master: LogoMaster,
  startDeg: number = LOGO.arcStartDeg,
): string {
  const { center: c, outerRadius: r, lift } = LOGO;
  const [sx, sy] = pointAt(startDeg);
  const span = 180 - startDeg;
  if (span <= 0 || span >= 360) {
    throw new Error(
      `The outer arc must start between -180° and 180°, not ${startDeg}°.`,
    );
  }
  const y = c - lift;
  let x = c - r;
  let d = `M${fmt(sx)} ${fmt(sy)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${fmt(x)} ${fmt(c)}`;
  if (lift) d += ` L${fmt(x)} ${fmt(y)}`;
  LOGO.masters[master].bowls.forEach((br, i) => {
    // Bowls alternate direction: left → right under the line, then back.
    x += (i % 2 ? -2 : 2) * br;
    d += ` A${br} ${br} 0 0 ${i % 2} ${fmt(x)} ${fmt(y)}`;
  });
  return d;
}

/** A dot drawn beside the logo (the tray icon's attention dot). */
export type Dot = { cx: number; cy: number; r: number };

/**
 * Asserts a dot sits in the outer arc's open quarter, clear of the line by at
 * least `gap`: a dot over the line would need it cut away, and a logo missing
 * a piece of its arc no longer reads as the logo (the tray's old attention dot
 * cut the arc's whole top-right quarter). Checks the outer arc and the rise —
 * the bowls hang below the rise, away from the open quarter.
 */
export function assertDotClear(
  master: LogoMaster,
  dot: Dot,
  gap: number,
): void {
  const { center: c, outerRadius: r, lift } = LOGO;
  const reach = dot.r + logoStroke(master) / 2 + gap;
  const points: (readonly [number, number])[] = [];
  for (let t = LOGO.arcStartDeg; t <= 180; t += 0.5) points.push(pointAt(t));
  for (let y = c; y >= c - lift; y -= 0.5) points.push([c - r, y]);
  for (const [x, y] of points) {
    if (Math.hypot(x - dot.cx, y - dot.cy) < reach) {
      throw new Error(
        `The dot at (${dot.cx}, ${dot.cy}) r${dot.r} comes within ${gap} of the logo's line at (${fmt(x)}, ${fmt(y)}).`,
      );
    }
  }
  if (
    dot.cx - dot.r < 0 ||
    dot.cy - dot.r < 0 ||
    dot.cx + dot.r > 100 ||
    dot.cy + dot.r > 100
  ) {
    throw new Error(
      `The dot at (${dot.cx}, ${dot.cy}) r${dot.r} leaves the view box.`,
    );
  }
}
