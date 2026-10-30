// The film's own building blocks over media/film: a Scene (what one section
// contributes — layers, camera keys, sound), a cursor walking a path, a still
// placed where it was captured, a crop of a tiled strip, the pane moves the
// continuous session is made of, and the theme colours of the end card.

import {
  cropLift,
  group,
  image,
  shape,
  type AssetManifest,
  type Easing,
  type GroupLayer,
  type ImageLayer,
  type Key,
  type Layer,
  type PlacedClip,
  type Rect,
  type SfxCue,
  type ShapeLayer,
  type Vec2,
} from "@plugins/media/plugins/film/e2e";

export const W = 1280;
export const H = 720;
export const CENTER: Vec2 = [W / 2, H / 2];

/** The website theme (apps/website/shell theme.ts). */
export const SITE = {
  bg: "oklch(0.1398 0.0117 265.76)",
  fg: "oklch(0.9674 0.0013 286.38)",
  muted: "oklch(0.7727 0.0127 286.10)",
  azure: "oklch(0.5461 0.2152 262.88)",
  cyan: "oklch(0.7971 0.1339 211.53)",
} as const;

export interface CamKeys {
  focus?: Key<Vec2>[];
  zoom?: Key[];
  tiltX?: Key[];
  tiltY?: Key[];
  roll?: Key[];
}

/** What one section adds to the film. Times are absolute film seconds. */
export interface Scene {
  /** Drawn under every other scene's layers (in scene order). */
  underlay?: Layer[];
  layers: Layer[];
  overlay?: Layer[];
  cam?: CamKeys;
  sfx?: SfxCue[];
  clips?: PlacedClip[];
}

export interface Ctx {
  m: AssetManifest;
}

/** A still drawn where it sat in its capture viewport. */
export function placed(
  m: AssetManifest,
  still: string,
  opts: Omit<ImageLayer, "kind" | "still"> = {},
): ImageLayer {
  const s = m.stills[still];
  if (!s) throw new Error(`promo-film: the manifest has no still "${still}"`);
  return image(still, { x: s.x, y: s.y, ...opts });
}

/** A still lifted by a literal rect (capture coordinates). */
export function lift(
  m: AssetManifest,
  still: string,
  r: Rect,
  opts: Omit<ImageLayer, "kind" | "still" | "crop"> = {},
): ImageLayer {
  return cropLift(m, still, r, opts);
}

export const centerOf = (r: Rect): Vec2 => [
  r.x + r.width / 2,
  r.y + r.height / 2,
];

/**
 * A rect of a tiled strip (strip page coordinates) as one group of tile crops,
 * its box the rect itself, placed at (x0 + rect.x, y0 + rect.y).
 */
export function stripCrop(
  m: AssetManifest,
  stripName: string,
  r: Rect,
  at: Vec2,
  opts: Omit<GroupLayer, "kind" | "children" | "width" | "height"> = {},
): GroupLayer {
  const st = m.strips[stripName];
  if (!st)
    throw new Error(`promo-film: the manifest has no strip "${stripName}"`);
  const children: Layer[] = [];
  st.tiles.forEach((tile, i) => {
    const s = m.stills[tile];
    if (!s) throw new Error(`promo-film: strip tile "${tile}" has no still`);
    const top = st.tops[i] as number;
    const bottom =
      i + 1 < st.tops.length ? (st.tops[i + 1] as number) : top + s.height;
    const y0 = Math.max(r.y, top);
    const y1 = Math.min(r.y + r.height, bottom);
    if (y1 <= y0) return;
    children.push(
      image(tile, {
        crop: [r.x - s.x, y0 - top, r.width, y1 - y0],
        y: y0 - r.y,
      }),
    );
  });
  return group(children, {
    width: r.width,
    height: r.height,
    x: at[0] + r.x,
    y: at[1] + r.y,
    ...opts,
  });
}

/** A cursor path point: [t, x, y, easing of the move that ends here]. */
export type CursorPoint = readonly [number, number, number, Easing?];

/** A cursor walking `path`, pressing at `clicks`, fading in at the first point and out after `end`. */
export function cursor(
  path: readonly CursorPoint[],
  clicks: number[],
  end: number,
): ShapeLayer {
  const first = path[0];
  if (!first) throw new Error("promo-film: an empty cursor path");
  const x: Key[] = path.map(([t, px, , e]) => [t, px, e ?? "inOutCubic"]);
  const y: Key[] = path.map(([t, , py, e]) => [t, py, e ?? "inOutCubic"]);
  return shape(
    { kind: "cursor", clicks, size: 26 },
    {
      start: first[0],
      end: end + 0.25,
      x,
      y,
      opacity: [
        [first[0], 0],
        [first[0] + 0.2, 1],
        [end, 1],
        [end + 0.25, 0],
      ],
    },
  );
}

/** Opacity in over [t, t+d] (and out over [t2, t2+d2]). */
export const fadeIn = (t: number, d: number): Key[] => [
  [t, 0],
  [t + d, 1, "inOutSine"],
];
export const fadeOut = (t: number, d: number): Key[] => [
  [t, 1],
  [t + d, 0, "inOutSine"],
];
export const fadeInOut = (t: number, d: number, t2: number, d2 = d): Key[] => [
  [t, 0],
  [t + d, 1, "inOutSine"],
  [t2, 1],
  [t2 + d2, 0, "inOutSine"],
];

/** A full-frame black dim over the world region `r` (opacity track given). */
export function dim(
  r: Rect,
  opacity: Key[],
  start: number,
  end: number,
): ShapeLayer {
  return shape(
    { kind: "rect", width: r.width, height: r.height, fill: "#000" },
    { x: r.x, y: r.y, opacity, start, end },
  );
}

/**
 * A side pane arriving: the new frame `next` (full capture) shows its left
 * part (up to `split`) cross-fading over the old frame, while its right pane
 * (from `split`) slides in from the right edge with a shadow. Ends on `next`
 * drawn whole (from `t + dur`, ending at `end`).
 */
export function paneArrive(
  m: AssetManifest,
  next: string,
  split: number,
  t: number,
  end: number,
  dur = 0.7,
): Layer[] {
  const done = t + dur;
  return [
    image(next, {
      start: t,
      end: done + 0.02,
      clipInset: [0, W - split, 0, 0],
      opacity: fadeIn(t, 0.3),
    }),
    lift(
      m,
      next,
      { x: split, y: 0, width: W - split, height: H },
      {
        start: t,
        end: done + 0.02,
        x: [
          [t, split + 260],
          [done, split, "outQuart"],
        ],
        opacity: fadeIn(t, 0.22),
        shadow: "-24px 0 48px rgba(0,0,0,0.45)",
      },
    ),
    image(next, { start: done, end }),
  ];
}

/**
 * A side pane taking the whole frame: the full capture `next` is wiped open
 * from the pane's left edge `from` to the left of the frame, while the frame
 * behind (`prev`) slides left, shrinks back and dims, and the narrow pane
 * (`prev` cropped from `from`) fades out over the first part of the wipe.
 */
export function paneFill(
  m: AssetManifest,
  prev: string,
  next: string,
  from: number,
  t: number,
  dur: number,
  end: number,
  /** How dimmed `prev` already is (0..1) — continues a `dim` drawn over it before the fill. */
  dimmed = 0,
): Layer[] {
  const done = t + dur;
  return [
    image(prev, {
      start: t,
      end: done + 0.02,
      origin: [0, H / 2],
      x: [
        [t, 0],
        [done, -160, "inOutCubic"],
      ],
      scale: [
        [t, 1],
        [done, 0.94, "inOutCubic"],
      ],
      opacity: [
        [t, 1 - dimmed],
        [done, 0.3, "inOutSine"],
      ],
      blur: [
        [t, 0],
        [done, 3, "inSine"],
      ],
    }),
    image(next, {
      start: t,
      end,
      clipInset: [
        [t, [0, 0, 0, from]],
        [done, [0, 0, 0, 0], "inOutCubic"],
      ],
      shadow: "-30px 0 60px rgba(0,0,0,0.5)",
    }),
    lift(
      m,
      prev,
      { x: from, y: 0, width: W - from, height: H },
      {
        start: t,
        end: t + dur * 0.55,
        x: [
          [t, from],
          [done, 0, "inOutCubic"],
        ],
        opacity: fadeOut(t, dur * 0.5),
      },
    ),
  ];
}

/** Concatenate scenes' camera keys per property, ordered by time (stable for equal times). */
export function mergeCam(scenes: Scene[]): Required<CamKeys> {
  const out: Required<CamKeys> = {
    focus: [],
    zoom: [],
    tiltX: [],
    tiltY: [],
    roll: [],
  };
  for (const s of scenes) {
    for (const k of Object.keys(out) as (keyof CamKeys)[]) {
      const keys = s.cam?.[k];
      if (keys)
        (out[k] as Key<number | Vec2>[]).push(
          ...(keys as Key<number | Vec2>[]),
        );
    }
  }
  for (const k of Object.keys(out) as (keyof CamKeys)[]) {
    const arr = out[k] as Key<number | Vec2>[];
    const sorted = arr
      .map((key, i) => ({ key, i }))
      .sort((a, b) => a.key[0] - b.key[0] || a.i - b.i)
      .map((e) => e.key);
    (out[k] as Key<number | Vec2>[]) = sorted;
  }
  return out;
}

/** Deterministic pseudo-random in [0, 1) for seed i. */
export const rand = (i: number): number => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
