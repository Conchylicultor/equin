// Synthesized sound-effect cues: what a composition asks the synth (page/sfx.ts)
// to play. Times are film seconds; `gain` is linear (1 = the cue's designed
// level: about -12 dBFS peak, small transients a few dB under).

export type SfxCue =
  /** Filtered-noise sweep for camera moves and transitions. */
  | {
      kind: "whoosh";
      at: number;
      dur: number;
      gain?: number;
      dir?: "up" | "down";
    }
  /**
   * Mouse click: a real recorded press at `at` and release `hold` s later
   * (default 0.08), the press peaking at CLICK_PEAK_DBFS × `gain`.
   */
  | { kind: "click"; at: number; hold?: number; gain?: number }
  /** One keystroke of a soft laptop keyboard (varied per `seed`). */
  | { kind: "key"; at: number; seed: number; gain?: number }
  /** UI element appearing: sine blip with a quick pitch drop; `pitch` in semitones. */
  | { kind: "pop"; at: number; pitch?: number; gain?: number }
  /** Tension builder ending exactly at `at + dur`. */
  | { kind: "riser"; at: number; dur: number; gain?: number }
  /** Cinematic hit: sub drop, noise burst and a long generated reverb tail. */
  | { kind: "impact"; at: number; gain?: number }
  /** Success chime: two bright notes, a rising third. */
  | { kind: "chime"; at: number; gain?: number }
  /** Sparkly "working" texture lasting `dur`. */
  | { kind: "shimmer"; at: number; dur: number; gain?: number }
  /** Notification ding. */
  | { kind: "ding"; at: number; gain?: number }
  /** Tiny transient for fast cuts and ripples. */
  | { kind: "tick"; at: number; gain?: number };

export type SfxKind = SfxCue["kind"];

/**
 * Where a click's press peaks at gain 1 (dBFS, on the SFX bus before the
 * mixer's `sfxGainDb`): a UI click plainly heard in a product promo, with or
 * without music. The recording is scaled to it from its own measured peak, so
 * swapping the sample keeps the level; the release keeps its recorded balance.
 */
export const CLICK_PEAK_DBFS = -14;

/** The cues inside [from, to), re-timed so `from` is 0 (a cue straddling `from` is dropped). */
export function cuesInRange(
  cues: readonly SfxCue[],
  from: number,
  to: number,
): SfxCue[] {
  return cues
    .filter((c) => c.at >= from && c.at < to)
    .map((c) => ({ ...c, at: c.at - from }));
}
