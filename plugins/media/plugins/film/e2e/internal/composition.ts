// A film is DATA: a Composition, built by a film script and handed whole to
// the generic page renderer, which knows nothing about any one film. Every
// coordinate is CSS px; the stage is `width`×`height` (rendered at DPR 1.5 for
// 1080p). Every animatable property is a Track (see tracks.ts).

import type { AssetManifest, Rect } from "./assets";
import type { SfxCue } from "./cues";
import type { Easing } from "./easing";
import type { Track } from "./tracks";

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
/** A rect as a track value: [x, y, width, height]. */
export type RectV = Vec4;

/** Properties every layer shares. A layer's (x, y) is its box's top-left in its parent's coordinates. */
export interface LayerBase {
  /** Names the layer for the camera's `space` and for debugging (`data-id`). */
  id?: string;
  /** Shown from `start` (inclusive) to `end` (exclusive); absent = always. */
  start?: number;
  end?: number;
  x?: Track;
  y?: Track;
  z?: Track;
  scale?: Track;
  rotateX?: Track;
  rotateY?: Track;
  rotateZ?: Track;
  opacity?: Track;
  /** Gaussian blur, px. */
  blur?: Track;
  /** Transform origin in the layer's own px; default its box centre. */
  origin?: Track<Vec2>;
  /** Clip to an inset [top, right, bottom, left] px of the box, rounded by `clipRadius`. */
  clipInset?: Track<Vec4>;
  clipRadius?: number;
  /** Clip to a circle [radius, cx, cy] px (layer coordinates). Wins over clipInset. */
  clipCircle?: Track<Vec3>;
  /** Static styling of the layer's box. */
  radius?: number;
  shadow?: string;
  blend?: string;
  style?: Record<string, string>;
}

/** A still from the manifest, optionally cropped to a rect of it (still CSS px). */
export interface ImageLayer extends LayerBase {
  kind: "image";
  still: string;
  /** The visible part, in the still's own coordinates. The box is the crop's size. */
  crop?: Track<RectV>;
}

/**
 * A manifest sequence: shows frame `frame` (floored, clamped) — or, for a
 * timed sequence with no `frame` track, the frame for `(t - playFrom) * fps`.
 */
export interface SequenceLayer extends LayerBase {
  kind: "sequence";
  sequence: string;
  frame?: Track;
  playFrom?: number;
}

/** A manifest strip (a tall page in viewport tiles); scroll it by moving `y`. */
export interface StripLayer extends LayerBase {
  kind: "strip";
  strip: string;
}

export interface TextRun {
  text: string;
  style?: Record<string, string>;
}

export interface TextReveal {
  by: "word" | "letter";
  /** First unit starts at `at`; unit i at `at + i * stagger`; each takes `duration`. */
  at: number;
  stagger: number;
  duration: number;
  easing?: Easing;
  /** Where each unit comes from: px offset, blur px, scale; opacity always 0 → 1. */
  fromY?: number;
  fromX?: number;
  fromBlur?: number;
  fromScale?: number;
}

/** Text in Inter Variable. Width wraps; omit it for one line. */
export interface TextLayer extends LayerBase {
  kind: "text";
  text: string | TextRun[];
  size: number;
  weight?: number;
  color?: string;
  width?: number;
  align?: "left" | "center" | "right";
  lineHeight?: number;
  letterSpacing?: string;
  reveal?: TextReveal;
}

export type Shape =
  | {
      kind: "rect";
      width: Track;
      height: Track;
      fill: string;
      radius?: number;
      border?: string;
    }
  /** A rounded outline with an outer glow, e.g. around a picked element. */
  | {
      kind: "ring";
      width: Track;
      height: Track;
      color: string;
      radius?: number;
      thickness?: number;
      glow?: number;
    }
  /**
   * Dims everything but a rounded hole (`hole`: [x, y, w, h] in the layer's
   * parent coordinates — place the layer at 0,0 beside what it spotlights).
   */
  | {
      kind: "spotlight";
      hole: Track<RectV>;
      radius?: number;
      feather?: number;
      color?: string;
    }
  /** A light band crossing a box; `progress` 0 → 1 moves it from left edge to right edge. */
  | {
      kind: "sweep";
      width: number;
      height: number;
      progress: Track;
      band?: number;
      angle?: number;
      color?: string;
      radius?: number;
    }
  /** A macOS-style arrow cursor; (x, y) is its hotspot. Each click presses it and pulses a ring. */
  | { kind: "cursor"; clicks?: number[]; size?: number; ringColor?: string };

export interface ShapeLayer extends LayerBase {
  kind: "shape";
  shape: Shape;
}

export interface GroupLayer extends LayerBase {
  kind: "group";
  /** Box size, for the default origin and for clipping; default 0×0 (origin at 0,0). */
  width?: number;
  height?: number;
  /** CSS perspective (px) the children render under; turns on preserve-3d. */
  perspective?: number;
  children: Layer[];
}

/**
 * Raw DOM the film must draw itself (a macOS menu bar, a Dock). `vars` sets
 * CSS custom properties every frame, so its own CSS can animate inside.
 */
export interface HtmlLayer extends LayerBase {
  kind: "html";
  html: string;
  width: number;
  height: number;
  vars?: Record<string, Track>;
}

export type Layer =
  | ImageLayer
  | SequenceLayer
  | StripLayer
  | TextLayer
  | ShapeLayer
  | GroupLayer
  | HtmlLayer;

export interface MotionBlur {
  /** Max blur px (default 6). */
  cap?: number;
  /** Screen px per 1/60 s below which nothing blurs (default 6). */
  threshold?: number;
  /** Blur px per px of speed above threshold (default 0.06). */
  gain?: number;
}

/**
 * The camera looks at `focus` (a point in layer `space`'s own coordinates,
 * mapped through that layer's transforms at t — so a capture's rects are
 * directly usable) and puts it at the stage centre, scaled by `zoom`, tilted.
 */
export interface Camera {
  /** Layer id whose coordinates `focus` is in; absent = world coordinates. */
  space?: string;
  focus?: Track<Vec2>;
  zoom?: Track;
  tiltX?: Track;
  tiltY?: Track;
  roll?: Track;
  /**
   * A rect ([x, y, w, h], in `space` coordinates like `focus`) the view must
   * never leave: on every frame the focus is clamped so the zoomed window stays
   * inside it (centred when it cannot fit). Set it to a recording's frame so
   * a push-in never shows past its edges. Untilted cameras only.
   */
  bounds?: RectV;
  /** Perspective of the stage the world plane tilts under (px, default 1600). */
  perspective?: number;
  /** Blur derived from the camera's screen velocity (none across a `"step"` key: a cut); `false` turns it off. */
  motionBlur?: MotionBlur | false;
}

/** Music: a file played from `sectionStart`, gain (dB) automated by keys — duck, cut to silence, fade. */
export interface MusicBed {
  /** Absolute path. */
  file: string;
  sectionStart: number;
  /** dB; ≤ -90 is silence. Linear in dB between keys. */
  gainDb?: Track;
}

/** A manifest audio clip placed at `at` (film seconds). */
export interface PlacedClip {
  audio: string;
  at: number;
  gainDb?: number;
  /** Seconds into the clip to start from / how long to play (default: to its end). */
  offset?: number;
  duration?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface FilmAudio {
  music?: MusicBed;
  clips?: PlacedClip[];
  sfx?: SfxCue[];
  /** Gain of the whole SFX bus, dB (default -3). */
  sfxGainDb?: number;
  /**
   * Integrated loudness target of the MUSIC BED, LUFS (default -16). Only the
   * bed is normalized; clips and SFX play at their own fixed levels.
   */
  loudness?: number;
}

export interface Composition {
  width: number;
  height: number;
  duration: number;
  background?: string;
  assets: { dir: string; manifest: AssetManifest };
  camera?: Camera;
  /** Under the camera. */
  layers: Layer[];
  /** Screen space, over the camera (captions, fades, vignettes). */
  overlay?: Layer[];
  /** Extra global CSS (for html layers). */
  css?: string;
  audio?: FilmAudio;
}

export type { Rect };
