// Small builders over the composition types: the shapes a film script writes
// over and over (a still lifted out of a capture by one of its rects, a typing
// sequence and its key ticks, a fade window). Everything they return is plain
// data — a script may always write the object literal instead.

import type { AssetManifest, Rect } from "./assets";
import type {
  Composition,
  GroupLayer,
  HtmlLayer,
  ImageLayer,
  Layer,
  LayerBase,
  RectV,
  SequenceLayer,
  Shape,
  ShapeLayer,
  StripLayer,
  TextLayer,
  Vec2,
} from "./composition";
import type { SfxCue } from "./cues";
import type { Easing } from "./easing";
import { checkTrack, type Key, type Track, type Value } from "./tracks";

type Opts<L> = Omit<L, "kind">;

export const rectV = (r: Rect): RectV => [r.x, r.y, r.width, r.height];

/** A rect grown by `pad` px on every side. */
export const inflate = (r: Rect, pad: number): Rect => ({
  x: r.x - pad,
  y: r.y - pad,
  width: r.width + 2 * pad,
  height: r.height + 2 * pad,
});

/** The centre of a rect, as a camera focus. */
export const center = (r: Rect): readonly [number, number] => [
  r.x + r.width / 2,
  r.y + r.height / 2,
];

export function image(
  still: string,
  opts: Omit<Opts<ImageLayer>, "still"> = {},
): ImageLayer {
  return { kind: "image", still, ...opts };
}

/** Look up a rect by name in the manifest (throws on a missing one). */
export function rectOf(manifest: AssetManifest, name: string): Rect {
  const r = manifest.rects[name];
  if (!r) throw new Error(`film: the manifest has no rect "${name}"`);
  return r;
}

/**
 * One element lifted out of a still: the still cropped to `rect` (capture
 * viewport coordinates, or a manifest rect name), placed exactly where it
 * sits over the uncropped still drawn at (0, 0) — so lifting it is seamless,
 * and animating its x/y/z/scale from there moves it off the page.
 */
export function cropLift(
  manifest: AssetManifest,
  still: string,
  rect: Rect | string,
  opts: Omit<Opts<ImageLayer>, "still" | "crop"> = {},
): ImageLayer {
  const s = manifest.stills[still];
  if (!s) throw new Error(`film: the manifest has no still "${still}"`);
  const r = typeof rect === "string" ? rectOf(manifest, rect) : rect;
  const crop: RectV = [r.x - s.x, r.y - s.y, r.width, r.height];
  return { kind: "image", still, crop, x: crop[0], y: crop[1], ...opts };
}

export function sequence(
  name: string,
  opts: Omit<Opts<SequenceLayer>, "sequence"> = {},
): SequenceLayer {
  return { kind: "sequence", sequence: name, ...opts };
}

export function strip(
  name: string,
  opts: Omit<Opts<StripLayer>, "strip"> = {},
): StripLayer {
  return { kind: "strip", strip: name, ...opts };
}

/**
 * A stepped (typing) sequence played from t0 to t1, one frame per step at
 * even intervals: the frame track, and one key-tick cue per step.
 */
export function typing(
  manifest: AssetManifest,
  name: string,
  t0: number,
  t1: number,
  opts: { keyGain?: number; seed?: number } = {},
): { frame: Track; cues: SfxCue[] } {
  const seq = manifest.sequences[name];
  if (!seq) throw new Error(`film: the manifest has no sequence "${name}"`);
  const n = seq.frames.length;
  if (n < 2) return { frame: 0, cues: [] };
  const step = (t1 - t0) / (n - 1);
  const frame: Key[] = [
    [t0, 0],
    [t1, n - 1],
  ];
  const cues: SfxCue[] = [];
  for (let i = 1; i < n; i++) {
    cues.push({
      kind: "key",
      at: t0 + i * step - step * 0.5,
      seed: (opts.seed ?? 0) * 1000 + i,
      gain: opts.keyGain ?? 0.6,
    });
  }
  return { frame, cues };
}

export function text(
  str: TextLayer["text"],
  opts: Omit<Opts<TextLayer>, "text">,
): TextLayer {
  return { kind: "text", text: str, ...opts };
}

export function group(
  children: Layer[],
  opts: Omit<Opts<GroupLayer>, "children"> = {},
): GroupLayer {
  return { kind: "group", children, ...opts };
}

export function shape(
  s: Shape,
  opts: Omit<Opts<ShapeLayer>, "shape"> = {},
): ShapeLayer {
  return { kind: "shape", shape: s, ...opts };
}

export function html(
  markup: string,
  width: number,
  height: number,
  opts: Omit<Opts<HtmlLayer>, "html" | "width" | "height"> = {},
): HtmlLayer {
  return { kind: "html", html: markup, width, height, ...opts };
}

/** A glowing outline around `r` (padded by `pad`). */
export function ring(
  r: Rect,
  opts: {
    pad?: number;
    color?: string;
    radius?: number;
    thickness?: number;
    glow?: number;
  } & LayerBase = {},
): ShapeLayer {
  const {
    pad = 4,
    color = "oklch(0.8 0.13 211)",
    radius,
    thickness,
    glow,
    ...base
  } = opts;
  const g = inflate(r, pad);
  return shape(
    {
      kind: "ring",
      width: g.width,
      height: g.height,
      color,
      radius,
      thickness,
      glow,
    },
    { x: g.x, y: g.y, ...base },
  );
}

/**
 * Opacity keys: fade in over [inAt, inAt + inDur], hold, fade out over
 * [outAt, outAt + outDur] (omit outAt to stay).
 */
export function fade(
  inAt: number,
  inDur: number,
  outAt?: number,
  outDur = inDur,
  easing: Easing = "inOutSine",
): Key[] {
  const k: Key[] = [
    [inAt, 0],
    [inAt + inDur, 1, easing],
  ];
  if (outAt !== undefined) k.push([outAt, 1], [outAt + outDur, 0, easing]);
  return k;
}

const TRACK_PROPS = [
  "x",
  "y",
  "z",
  "scale",
  "rotateX",
  "rotateY",
  "rotateZ",
  "opacity",
  "blur",
  "origin",
  "clipInset",
  "clipCircle",
] as const;

/** Throws on misordered keys, duplicate ids and an empty window, naming the layer. */
export function checkComposition(comp: Composition): void {
  if (!(comp.duration > 0))
    throw new Error(`film: bad duration ${comp.duration}`);
  const ids = new Set<string>();
  const walk = (ls: Layer[], path: string): void => {
    ls.forEach((l, i) => {
      const where = `${path}/${l.id ?? `${l.kind}#${i}`}`;
      if (l.id !== undefined) {
        if (ids.has(l.id))
          throw new Error(`film: two layers have id "${l.id}"`);
        ids.add(l.id);
      }
      if (l.start !== undefined && l.end !== undefined && !(l.end > l.start)) {
        throw new Error(
          `film: ${where} ends (${l.end}) before it starts (${l.start})`,
        );
      }
      for (const p of TRACK_PROPS)
        checkTrack(l[p] as Track<Value> | undefined, `${where}.${p}`);
      if (l.kind === "image") checkTrack(l.crop, `${where}.crop`);
      if (l.kind === "sequence") checkTrack(l.frame, `${where}.frame`);
      if (l.kind === "group") walk(l.children, where);
    });
  };
  walk(comp.layers, "layers");
  walk(comp.overlay ?? [], "overlay");
  const c = comp.camera;
  if (c) {
    if (c.space !== undefined && !ids.has(c.space))
      throw new Error(`film: camera space "${c.space}" names no layer`);
    for (const p of ["focus", "zoom", "tiltX", "tiltY", "roll"] as const)
      checkTrack(c[p], `camera.${p}`);
    // bounds are clamped in the flat stage plane: a tilted or rolled view's
    // footprint is not that window, so the guarantee would not hold.
    if (
      c.bounds !== undefined &&
      [c.tiltX, c.tiltY, c.roll].some(
        (tr) =>
          tr !== undefined &&
          (Array.isArray(tr)
            ? (tr as readonly (readonly [number, number])[]).some(
                (k) => k[1] !== 0,
              )
            : tr !== 0),
      )
    )
      throw new Error(
        "film: camera.bounds cannot be combined with tilt or roll",
      );
  }
  checkTrack(comp.audio?.music?.gainDb, "audio.music.gainDb");
  for (const cue of comp.audio?.sfx ?? []) {
    if (!(cue.at >= 0 && cue.at < comp.duration))
      throw new Error(
        `film: ${cue.kind} cue at ${cue.at}s is outside the ${comp.duration}s film`,
      );
  }
  for (const clip of comp.audio?.clips ?? []) {
    if (!comp.assets.manifest.audio[clip.audio])
      throw new Error(`film: the manifest has no audio clip "${clip.audio}"`);
  }
}

function recordedInput(manifest: AssetManifest, name: string) {
  const seq = manifest.sequences[name];
  if (!seq) throw new Error(`film: the manifest has no sequence "${name}"`);
  if (!seq.input)
    throw new Error(
      `film: sequence "${name}" is not a recording (no input log)`,
    );
  return seq.input;
}

/**
 * The pointer of a recorded session (a sequence with an input log) as a
 * cursor layer: at the logged position every frame, pressed at each click.
 * `start` is the film time the sequence's frame 0 plays at; the layer is in
 * the sequence's own coordinates (place it beside the sequence layer, in the
 * same parent).
 */
export function recordedCursor(
  manifest: AssetManifest,
  name: string,
  opts: { start?: number; size?: number; ringColor?: string } & Omit<
    LayerBase,
    "x" | "y"
  > = {},
): ShapeLayer {
  const { start = 0, size, ringColor, ...base } = opts;
  const input = recordedInput(manifest, name);
  if (input.cursor.length === 0)
    throw new Error(`film: recording "${name}" has no cursor positions`);
  const x: Key[] = input.cursor.map(([t, cx]) => [start + t, cx]);
  const y: Key[] = input.cursor.map(([t, , cy]) => [start + t, cy]);
  return shape(
    {
      kind: "cursor",
      clicks: input.clicks.map((c) => start + c.t),
      size,
      ringColor,
    },
    { ...base, x, y },
  );
}

/**
 * The real mouse click (recorded press + release, the press peaking at
 * CLICK_PEAK_DBFS × `clickGain`) for every press of a recorded session, film time =
 * `start` + log time. Typing makes no sound unless `keyGain` is given (a
 * synthesized key tick per key) — the engine has no recorded keystroke.
 */
export function recordedSfx(
  manifest: AssetManifest,
  name: string,
  opts: { start?: number; clickGain?: number; keyGain?: number } = {},
): SfxCue[] {
  const { start = 0, clickGain = 1, keyGain } = opts;
  const input = recordedInput(manifest, name);
  const keys =
    keyGain === undefined
      ? []
      : input.keys.map((k, i): SfxCue => ({
          kind: "key",
          at: start + k.t,
          seed: i + 1,
          gain: keyGain,
        }));
  return [
    ...input.clicks.map((c): SfxCue => ({
      kind: "click",
      at: start + c.t,
      hold: c.upAt - c.t,
      gain: clickGain,
    })),
    ...keys,
  ].sort((a, b) => a.at - b.at);
}

/**
 * The camera framing that shows `target` — grown by `margin` px on every side
 * — whole, as large as `maxZoom` allows, without ever showing past `bounds`
 * (default: the stage, i.e. a full-frame recording): the grown rect is first
 * clipped to the bounds, the zoom is the largest at which it fits the stage,
 * and the focus is its centre clamped so the window stays in bounds. Clamping
 * only slides the window toward the inside, so the clipped rect stays whole in
 * frame. Pair it with `camera.bounds`, which applies the same clamp on every
 * frame between keys.
 */
export function frameOn(
  target: Rect,
  opts: {
    stage: { width: number; height: number };
    bounds?: Rect;
    margin?: number;
    maxZoom?: number;
  },
): { focus: Vec2; zoom: number } {
  const { stage, margin = 24, maxZoom = 2 } = opts;
  const b = opts.bounds ?? { x: 0, y: 0, ...stage };
  const g = inflate(target, margin);
  const x0 = Math.max(b.x, g.x);
  const y0 = Math.max(b.y, g.y);
  const x1 = Math.min(b.x + b.width, g.x + g.width);
  const y1 = Math.min(b.y + b.height, g.y + g.height);
  if (!(x1 > x0 && y1 > y0))
    throw new Error(
      `film: frameOn target [${rectV(target).join(", ")}] lies outside the bounds`,
    );
  const fit = Math.min(stage.width / (x1 - x0), stage.height / (y1 - y0));
  // Never below the zoom at which the window fills the bounds' smaller side.
  const zoom = Math.max(
    Math.min(maxZoom, fit),
    Math.max(stage.width / b.width, stage.height / b.height),
  );
  if (fit < zoom - 1e-9)
    throw new Error(
      `film: frameOn target [${rectV(target).join(", ")}] + ${margin} px cannot fit at a zoom that stays inside the bounds`,
    );
  const hw = stage.width / 2 / zoom;
  const hh = stage.height / 2 / zoom;
  const focus: Vec2 = [
    Math.min(b.x + b.width - hw, Math.max(b.x + hw, (x0 + x1) / 2)),
    Math.min(b.y + b.height - hh, Math.max(b.y + hh, (y0 + y1) / 2)),
  ];
  return { focus, zoom };
}
