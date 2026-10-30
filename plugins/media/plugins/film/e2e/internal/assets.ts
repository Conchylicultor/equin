// The asset contract between a film's capture script and the engine: what a
// capture writes next to its PNGs as `manifest.json`, and what a composition
// addresses by name. Every coordinate is CSS px in the viewport the still was
// taken in; every PNG is `dpr`× that.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One captured image. Its rect is where it sat in its capture viewport (a full frame is {0,0,vw,vh}). */
export interface Still extends Rect {
  /** File name in the assets dir. */
  file: string;
}

/**
 * Frames of one moving thing, in order, each a crop at the same `clip`: a
 * prompt typing itself (one frame per step), a player mid-playback (one frame
 * per `fps` tick). The composition picks the frame for t.
 */
export interface Sequence {
  frames: string[];
  clip: Rect;
  /** Capture rate for a timed sequence; absent for a stepped one (typing). */
  fps?: number;
  /** The text a typing sequence types, for its key-tick SFX. */
  text?: string;
  /** A recorded session (record.ts): the inputs that drove it, on its own timeline. */
  input?: InputLog;
}

/**
 * Every input of a recorded session, in seconds from its frame 0 (frame i is
 * at i / fps) and CSS px of the capture viewport — what a film draws the
 * cursor from and places camera moves and SFX on.
 */
export interface InputLog {
  /** The pointer at every frame: [t, x, y], one per frame. */
  cursor: Array<[number, number, number]>;
  /** Button presses: `t` the press, `upAt` the release. */
  clicks: Array<{ t: number; upAt: number; x: number; y: number }>;
  /** Keys typed or pressed; `text` for a printable character. */
  keys: Array<{ t: number; key: string; text?: string }>;
  /** Named beats the script marked, with the rect of their element then (if any). */
  marks: Record<string, { t: number; rect?: Rect }>;
}

/** A page taller than the viewport, captured as viewport tiles stacked top to bottom. */
export interface Strip {
  /** Still names, one per tile; tile i's top is `tops[i]` in page coordinates. */
  tiles: string[];
  tops: number[];
  height: number;
}

/** An audio clip a capture recorded or rendered (a player's own sound), placed by the composition. */
export interface AudioClip {
  file: string;
  duration: number;
}

export interface AssetManifest {
  dpr: number;
  /** Capture viewport, CSS px. */
  width: number;
  height: number;
  stills: Record<string, Still>;
  /** Element rects (CSS px, capture viewport) the camera, cursor and spotlight target. */
  rects: Record<string, Rect>;
  sequences: Record<string, Sequence>;
  strips: Record<string, Strip>;
  /** Rects in a strip's page coordinates (not the viewport's), keyed `<strip>/<name>`. */
  stripRects: Record<string, Rect & { label: string }>;
  audio: Record<string, AudioClip>;
}
