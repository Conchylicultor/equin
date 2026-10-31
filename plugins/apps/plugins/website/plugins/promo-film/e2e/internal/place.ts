// A recorded segment placed on the film's timeline through a time map:
// knots (film t, recording t), linear between them — 1:1 for real time, a
// steeper slope for a time-lapse. Everything the segment carries follows the
// same map: the frames, the pointer drawn over them (and its presses), the
// recorded clicks' sound, and its marks (where the camera and captions cue).

import {
  sequence,
  shape,
  type AssetManifest,
  type Key,
  type Layer,
  type Rect,
  type SfxCue,
} from "@plugins/media/plugins/film/e2e";

/** [film t, recording t]; both strictly increasing. */
export type Knot = readonly [number, number];

export interface Placed {
  name: string;
  /** Film time the segment starts / stops showing. */
  from: number;
  to: number;
  /** Film time of recording time `rec`. */
  film(rec: number): number;
  /** Film time of a mark. */
  at(mark: string): number;
  /** A mark's element rect (capture px). */
  rect(mark: string): Rect;
  /** Recording time at the segment's last shown film instant. */
  lastRec: number;
  layers: Layer[];
  sfx: SfxCue[];
}

const lerp = (ks: readonly Knot[], x: number, xi: 0 | 1): number => {
  const yi = xi === 0 ? 1 : 0;
  const first = ks[0];
  const last = ks[ks.length - 1];
  if (!first || !last) throw new Error("promo-film: an empty time map");
  if (x <= first[xi]) return first[yi] + (x - first[xi]);
  if (x >= last[xi]) return last[yi] + (x - last[xi]);
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1] as Knot;
    const b = ks[i] as Knot;
    if (x <= b[xi])
      return a[yi] + ((x - a[xi]) / (b[xi] - a[xi])) * (b[yi] - a[yi]);
  }
  return last[yi];
};

/**
 * Place recording `name` by `knots`; it shows over [first knot, last knot)
 * in film time. `cursor: false` draws no pointer.
 */
export function place(
  m: AssetManifest,
  name: string,
  knots: readonly Knot[],
  opts: { cursor?: boolean; keyGain?: number; clickGain?: number } = {},
): Placed {
  const seq = m.sequences[name];
  if (!seq?.input || !seq.fps)
    throw new Error(`promo-film: "${name}" is not a recording`);
  const fps = seq.fps;
  const input = seq.input;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1] as Knot;
    const b = knots[i] as Knot;
    if (!(b[0] > a[0] && b[1] > a[1]))
      throw new Error(`promo-film: ${name}'s time map is not increasing`);
  }
  const first = knots[0] as Knot;
  const last = knots[knots.length - 1] as Knot;
  const recEnd = (seq.frames.length - 1) / fps;
  if (last[1] > recEnd + 1e-6)
    throw new Error(
      `promo-film: ${name} is placed up to ${last[1].toFixed(2)} s but holds ${recEnd.toFixed(2)} s`,
    );
  const from = first[0];
  const to = last[0];
  const film = (rec: number): number => lerp(knots, rec, 1);
  const inside = (rec: number): boolean =>
    rec >= first[1] - 1e-6 && rec <= last[1] + 1e-6;
  const mark = (n: string) => {
    const mk = input.marks[n];
    if (!mk) throw new Error(`promo-film: ${name} has no mark "${n}"`);
    return mk;
  };

  const layers: Layer[] = [
    sequence(name, {
      id: `seq-${name}`,
      start: from,
      end: to,
      // A hair past each frame index, so float error never floors to the frame before.
      frame: knots.map(([f, r]): Key => [f, r * fps + 1e-3]),
    }),
  ];
  if (opts.cursor ?? true) {
    const pts = input.cursor.filter(([t]) => inside(t));
    const x: Key[] = pts.map(([t, cx]) => [film(t), cx]);
    const y: Key[] = pts.map(([t, , cy]) => [film(t), cy]);
    layers.push(
      shape(
        {
          kind: "cursor",
          clicks: input.clicks.filter((c) => inside(c.t)).map((c) => film(c.t)),
          size: 22,
        },
        { start: from, end: to, x, y },
      ),
    );
  }
  const sfx: SfxCue[] = [
    ...input.clicks
      .filter((c) => inside(c.t) && film(c.t) < to)
      .map((c): SfxCue => ({
        kind: "click",
        at: film(c.t),
        hold: film(c.upAt) - film(c.t),
        gain: opts.clickGain ?? 1,
      })),
    ...(opts.keyGain === undefined
      ? []
      : input.keys
          .filter((k) => k.text !== undefined && inside(k.t))
          .map((k, i): SfxCue => ({
            kind: "key",
            at: film(k.t),
            seed: i + 1,
            gain: opts.keyGain,
          }))),
  ];
  return {
    name,
    from,
    to,
    film,
    at: (n) => film(mark(n).t),
    rect: (n) => {
      const r = mark(n).rect;
      if (!r) throw new Error(`promo-film: ${name}'s mark "${n}" has no rect`);
      return r;
    },
    lastRec: last[1],
    layers,
    sfx,
  };
}

/** A recording's duration (s), from its first frame to its last. */
export function recDuration(m: AssetManifest, name: string): number {
  const seq = m.sequences[name];
  if (!seq?.fps) throw new Error(`promo-film: no recording "${name}"`);
  return (seq.frames.length - 1) / seq.fps;
}

/** A recording's mark time (recording seconds). */
export function recMark(m: AssetManifest, name: string, mark: string): number {
  const mk = m.sequences[name]?.input?.marks[mark];
  if (!mk) throw new Error(`promo-film: ${name} has no mark "${mark}"`);
  return mk.t;
}

/** A recording's mark rect (capture px). */
export function recRect(m: AssetManifest, name: string, mark: string): Rect {
  const r = m.sequences[name]?.input?.marks[mark]?.rect;
  if (!r)
    throw new Error(`promo-film: ${name} has no mark "${mark}" with a rect`);
  return r;
}
