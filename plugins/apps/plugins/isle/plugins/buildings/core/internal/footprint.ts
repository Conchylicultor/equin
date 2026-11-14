// The declared footprint of a planned building: computed analytically from the
// plan, mirroring what `paint` and the animation draw — never by painting and
// measuring. Each element contributes a conservative box (its geometry plus the
// ink its strokes add); the boxes are split at the ground band's top edge
// (y = -GROUND_BAND) into the `ground` and `upper` parts.
//
// The footprint test (`kit-building.test.ts`) paints every kind of building on
// a measuring context and checks this stays a tight, safe over-estimate.

import { GROUND_BAND, type Box } from "../spec";
import { bbox, type Pt } from "./draw";
import {
  annexOf,
  doorHeight,
  doorWidth,
  propsAnchor,
  roofShape,
  shadowPts,
  smokeAnchor,
  wallHeight,
  windowSlots,
  type RoofShape,
} from "./layout";
import type { Plan, Wall } from "./plan";

/** What a hand-inked sketch outline adds around its rectangle (wobble, second pass, pen). */
const SKETCH_PAD = 3;

type MutBox = [number, number, number, number];

/** Collects boxes, split at the ground band's top edge. */
class Extent {
  private ground: MutBox | null = null;
  private upper: MutBox | null = null;

  add(x0: number, y0: number, x1: number, y1: number): void {
    if (y1 > -GROUND_BAND)
      this.ground = hull(this.ground, [x0, Math.max(y0, -GROUND_BAND), x1, y1]);
    if (y0 < -GROUND_BAND)
      this.upper = hull(this.upper, [x0, y0, x1, Math.min(y1, -GROUND_BAND)]);
  }

  addBox(b: Box, pad = 0): void {
    this.add(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
  }

  result(): { ground: Box; upper: Box | null } {
    if (!this.ground)
      throw new Error("buildings: a building with nothing on the ground");
    return {
      ground: outward(this.ground),
      upper: this.upper ? outward(this.upper) : null,
    };
  }
}

function hull(a: MutBox | null, b: MutBox): MutBox {
  if (!a) return b;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** Rounded outward to whole pixels. */
const outward = (b: MutBox): Box => [
  Math.floor(b[0]),
  Math.floor(b[1]),
  Math.ceil(b[2]),
  Math.ceil(b[3]),
];

/** A wall of `wall` material over a rect: its box including the ink its material adds. */
function wallBox(
  wall: Wall,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Box {
  if (wall === "logs") return [x0 - 9, y0 - 10, x1 + 9, y1 + 1]; // log ends stick out either side
  if (wall === "timber") return [x0 - 5, y0 - 4, x1 + 5, y1 + 4]; // beams are stroked 5 wide
  return [x0 - SKETCH_PAD, y0 - SKETCH_PAD, x1 + SKETCH_PAD, y1 + SKETCH_PAD];
}

/** A window's box, sill and shutters included. */
function windowBox(
  x: number,
  y: number,
  w: number,
  h: number,
  shutters: boolean,
): Box {
  const top = y - h;
  return shutters
    ? [
        x - w / 2 - 2 - SKETCH_PAD,
        top - SKETCH_PAD,
        x + w + 2 + w / 2 + SKETCH_PAD,
        y + SKETCH_PAD + 1,
      ]
    : [x - 4, top - 1.5, x + w + 4, y + 5];
}

/** Rotates the box `b` by `a` radians about the origin and returns the box around it. */
function rotated(b: Box, a: number): Box {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return bbox(
    (
      [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[0], b[3]],
        [b[2], b[3]],
      ] as const
    ).map(([x, y]): Pt => [c * x - s * y, s * x + c * y]),
  );
}

/** The roof of a rectangular body, its dormers included. */
function addRoof(e: Extent, p: Plan, R: RoofShape): void {
  const thatch = p.roof === "thatch";
  if (R.form === "gablefront") {
    // barge boards are stroked 4 wide
    e.addBox([R.x0 - R.ov, R.topY, R.x1 + R.ov, R.eaveY + 6], 4);
  } else if (thatch) {
    e.add(R.x0 - R.ov - 2, R.top - 6.5, R.x1 + R.ov + 2, R.eaveY + 4 + 7.5); // ragged eave
  } else {
    e.add(R.x0 - R.ov - 4, R.top - 5.5, R.x1 + R.ov + 4, R.eaveY + 4 + 4);
  }
  for (const { dx, dy } of R.dormers) {
    e.addBox([dx - 14, dy - 30, dx + 14, dy + 4], SKETCH_PAD + 1);
  }
}

// ---------------------------------------------------------------- props

/**
 * A cast shadow's widest stroke is 14 px; the measuring context widens a stroke
 * by √2 under an identity transform (it cannot know the join), so a shadow
 * reaches 7·√2 past its polygon.
 */
const SHADOW = 7 * Math.SQRT2;

const shadowBox = (pts: readonly Pt[]): Box => {
  const b = bbox(pts);
  return [b[0] - SHADOW, b[1] - SHADOW, b[2] + SHADOW, b[3] + SHADOW];
};

const crateBox = (x: number, y: number, s: number): Box => {
  const sh = shadowBox([
    [x, y],
    [x + s + 6, y + 4],
  ]);
  return [sh[0], y - s - 5, sh[2], sh[3]];
};
const barrelBox = (x: number, y: number, r: number): Box => {
  const sh = shadowBox([
    [x - r, y],
    [x + r + 7, y + 4],
  ]);
  return [sh[0], y - r * 2.3 - r * 0.38 - 2, sh[2], sh[3]];
};
const sackBox = (x: number, y: number, s: number): Box => {
  const sh = shadowBox([
    [x - s, y],
    [x + s + 5, y + 3],
  ]);
  return [
    Math.min(sh[0], x - s * 1.2 - 2),
    y - s * 1.7 - 2,
    Math.max(sh[2], x + s * 1.2 + 2),
    sh[3],
  ];
};
const benchBox = (x: number, y: number, w: number): Box => {
  const sh = shadowBox([
    [x, y],
    [x + w + 6, y + 5],
  ]);
  return [sh[0], y - 28, sh[2], sh[3]];
};
const cartBox = (x: number, y: number): Box => {
  const sh = shadowBox([
    [x - 18, y],
    [x + 30, y + 5],
  ]);
  return [sh[0], y - 21, Math.max(sh[2], x + 37), sh[3]];
};
const toolRackBox = (x: number, y: number): Box => [
  x - 14,
  y - 38.5,
  x + 14,
  y + 1,
];
const easelBox = (x: number, y: number): Box => {
  const sh = shadowBox([
    [x - 10, y],
    [x + 18, y + 4],
  ]);
  return [sh[0], y - 42, sh[2], sh[3]];
};
const draftingTableBox = (x: number, y: number): Box => {
  const sh = shadowBox([
    [x - 14, y],
    [x + 22, y + 4],
  ]);
  return [sh[0], y - 28, sh[2], sh[3]];
};
const mailboxBox = (x: number, y: number): Box => {
  const sh = shadowBox([
    [x - 4, y],
    [x + 10, y + 3],
  ]);
  return [sh[0], y - 35.5, Math.max(sh[2], x + 17), sh[3]];
};
const swingBox = (x: number, y: number): Box => {
  const sh = shadowBox([
    [x - 18, y],
    [x + 26, y + 5],
  ]);
  return [sh[0], y - 44, sh[2], sh[3]];
};
const gearBox = (x: number, y: number, R: number): Box => [
  x - R - 1.5,
  y - R * 0.92 - 1.5,
  x + R + 1.5,
  y + R * 0.92 + 1.5,
];
const ladderBox = (x: number, y: number, h: number): Box => [
  x - 2.5,
  y - h - 2.5,
  x + 20.5,
  y + 2.5,
];
const lanternBox = (x: number, y: number): Box => [x - 5, y - 14, x + 5, y + 4];

function luteBox(x: number, y: number): Box {
  const b = rotated([-8, -25, 8, 10], -0.5);
  return [x + b[0], y + b[1], x + b[2], y + b[3]];
}

function waterButtBox(x: number, y: number): Box {
  const b = barrelBox(x, y, 9);
  return [b[0], Math.min(b[1], y - 58.2), Math.max(b[2], x + 5.2), b[3]];
}

/** The boxes of the props of a category (the set `paintProps` draws), around the anchor `x`. */
function propBoxes(p: Plan, x: number): Box[] {
  const s = p.side;
  const X = (d: number) => x + s * d;
  switch (p.cat) {
    case "work":
      return [
        crateBox(X(4), 18, 13),
        crateBox(X(16), 22, 11),
        p.maxW > 160 ? cartBox(X(26), 32) : toolRackBox(X(6), 2),
        barrelBox(X(-2), 34, 7),
      ];
    case "create":
      // an easel or a drafting table, chosen from the random stream: declare both
      return [
        easelBox(X(10), 24),
        draftingTableBox(X(12), 24),
        crateBox(X(-4), 34, 9),
      ];
    case "music":
      return [
        benchBox(X(-6) - (s < 0 ? 34 : 0), 26, 34),
        luteBox(X(10), 12),
        lanternBox(X(-12), -46),
      ];
    case "life":
      return [
        benchBox(X(-4) - (s < 0 ? 32 : 0), 28, 32),
        mailboxBox(X(26), 30),
      ];
    case "data":
      return [
        barrelBox(X(4), 20, 8),
        barrelBox(X(20), 24, 8),
        sackBox(X(8), 34, 8),
        sackBox(X(-6), 30, 7),
        crateBox(X(28), 34, 10),
      ];
    case "play":
      return [swingBox(X(22), 30)];
    case "system":
      return [
        gearBox(X(8), 14, 12),
        ladderBox(X(-14), 0, 52),
        waterButtBox(X(-4), 30),
      ];
  }
}

/** What the swing seat of a `play` building sweeps as it sways (|angle| ≤ 0.25 rad). */
function swingSweep(x: number): Box {
  const local: Box = [-9.5, -1, 9.5, 33];
  const boxes = [-0.25, 0, 0.25].map((a) => rotated(local, a));
  const b = bbox(
    boxes.flatMap((r): Pt[] => [
      [r[0], r[1]],
      [r[2], r[3]],
    ]),
  );
  return [x + b[0], -10 + b[1], x + b[2], -10 + b[3]];
}

// ---------------------------------------------------------------- the whole building

/** What the footprint declares, besides the base `w` / `depth` the generator derives. */
export function footprintBoxes(p: Plan): { ground: Box; upper: Box | null } {
  const e = new Extent();
  const { W2 } = p;
  const wallH = wallHeight(p);
  const WT = -wallH;
  const dH = doorHeight(p);
  const dW = doorWidth(p);

  e.addBox(shadowBox(shadowPts(p)));

  const annex = annexOf(p);
  if (annex) {
    e.addBox(wallBox(annex.wall, annex.x0, -annex.h, annex.x1, 0));
    e.addBox(bbox(annex.roof), p.roof === "thatch" ? 1 : SKETCH_PAD + 1);
  }

  if (p.arch === "tower") {
    e.add(-W2 - 1.5, WT - 1.5, W2 + 1.5, W2 * 0.18 + 1.5); // the round shaft
    const ch = Math.round(W2 * 1.5 + 20);
    e.add(
      -W2 - 10 - SKETCH_PAD - 1,
      WT - ch - SKETCH_PAD - 1,
      W2 + 10 + SKETCH_PAD + 1,
      WT + 12,
    ); // cone roof and its eave
    e.add(-2, WT - ch - 16, 13, WT - ch - 6); // flag
  } else if (p.arch === "hut") {
    e.add(-W2 - 1.5, WT - 1.5, W2 + 1.5, W2 * 0.2 + 1.5); // the round drum
    for (const wx of [-W2 * 0.6, W2 * 0.6])
      e.addBox(windowBox(wx - 7, -14, 14, 16, false));
    const R2 = W2 + 14;
    const dh = Math.round(W2 * 1.05 + 20);
    e.add(-R2 - 2, WT + 10 - dh - 1, R2 + 2, WT + 10 + 10 + 7.5); // the thatched dome and its eave
    e.add(-11.5, WT + 10 - dh - 25, 11.5, WT + 10 - dh + 10); // the cupola
  } else {
    const R = roofShape(p, -W2, W2, WT);
    addRoof(e, p, R);
    e.addBox(wallBox(p.wall, -W2, WT, W2, 0));
    if (!(p.wall === "rubble" || p.wall === "ashlar")) {
      e.addBox([
        -W2 - SKETCH_PAD,
        -12 - SKETCH_PAD,
        W2 + SKETCH_PAD,
        SKETCH_PAD,
      ]); // the plinth
    }
    for (const w of windowSlots(p)) {
      e.addBox(windowBox(w.x, w.y, 24, w.h, p.shutters));
      if (p.flowerBoxes && w.y > -40)
        e.add(w.x - 6, w.y - 4, w.x + 31, w.y + 12);
    }
    if (p.storeys === 2) e.addBox(windowBox(-10, WT / 2 - 10, 20, 22, false));
    if (p.chimney) {
      const x = R.chimX;
      const y = R.chimY;
      e.add(x - 11, y - 39, x + 11, y + 8); // the chimney
    }
  }

  // door and porch
  if (p.arch === "storehouse") {
    const w = Math.min(64, W2);
    const h = Math.min(54, wallH - 8);
    e.add(-w / 2 - 18, -h - 7, w / 2 + 18, 4.5);
  } else {
    const y = -dH - 8;
    if (p.porch === "awning") e.add(-dW - 9, y - 1, dW + 15, y + 20);
    else if (p.porch === "porch")
      e.add(-dW - 8 - 4, y - 14 - 4, dW + 8 + 4, 4 + 4);
    else if (p.porch === "hood")
      e.add(-dW + 4 - 4, y - 14 - 4, dW - 4 + 4, y + 12 + 3);
    e.add(-17, -dH - 6, 17, 4); // door, surround and the worn step
    e.add(-18, -3, 18, 4);
  }

  // ivy, moss, tufts
  if (p.ivy) {
    const x = p.ivy * (W2 - 10);
    e.add(x - 22.5, -wallH * 0.85 - 4.5, x + 22.5, 3);
  }
  e.add(-W2 - 9, -11, W2 + 9, 5);
  e.add(-W2 - 16, -9.5, W2 + 16, 7.5);

  // the bracket sign
  {
    const dir = p.signBracket;
    const x = dir * (W2 - 2);
    const y = -dH - (p.arch === "tower" ? 30 : 6);
    const bx = x + dir * 18;
    e.add(
      Math.min(x, x + dir * 26) - 2,
      y - 2,
      Math.max(x, x + dir * 26) + 2,
      y + 10,
    );
    e.add(
      bx - 10 - SKETCH_PAD,
      y + 5 - SKETCH_PAD,
      bx + 10 + SKETCH_PAD,
      y + 23 + SKETCH_PAD,
    );
  }

  // props, and (play) the swinging seat
  const anchor = propsAnchor(p);
  for (const b of propBoxes(p, anchor)) e.addBox(b);
  if (p.cat === "play") e.addBox(swingSweep(anchor + p.side * 22));

  // shrubs: positions drawn from the random stream, so declare every place they may stand
  {
    const lo = Math.max(26, W2 * 0.3);
    const hi = W2 * 0.8;
    if (hi >= 26) {
      e.add(-hi - 20, -13.5, -lo + 20, 30.5);
      if (p.shrubs >= 2) e.add(lo - 20, -13.5, hi + 20, 30.5);
    }
  }

  if (p.cat === "music" || p.cat === "life")
    e.addBox(lanternBox(-p.signBracket * 18, -dH - 12));

  // animation: smoke, the light from an open door
  const smoke = smokeAnchor(p);
  if (smoke) e.add(smoke[0] - 9, smoke[1] - 84, smoke[0] + 44, smoke[1] + 4);
  e.add(-33, 0, 33, 38);

  return e.result();
}

/** The solid base the walker cannot cross: width, depth — as the generator declares them. */
export function baseSize(p: Plan): { w: number; depth: number } {
  const footW = 2 * (p.W2 + (p.annex ? p.annexW : 0)); // symmetric about the door: covers the annex side
  return {
    w: Math.min(p.maxW, footW),
    depth: Math.min(100, p.arch === "tower" ? 50 : 60 + (p.storeys - 1) * 20),
  };
}

/** The signpost's x: just past the base on the side opposite the props. */
export function signX(p: Plan): number {
  return (
    -p.side *
    Math.min(p.maxW / 2 + 4, p.W2 + (p.annex === -p.side ? p.annexW : 0) + 26)
  );
}
