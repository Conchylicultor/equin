import { z } from "zod";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// ── Where a section's beats sit in its recording ─────────────────────────────
//
// Every beat here is a Hookpad beat: 1-based, counted from the section start.

/**
 * A beat → seconds map through fixed points, read piecewise linearly. Sheet
 * Sage's per-beat ("refined") alignment, or its two-point start/end ("user")
 * one, shifted to Hookpad beats.
 */
export type BeatTimesAlignment = {
  kind: "beat-times";
  /** Strictly increasing Hookpad beats, at least two. */
  beats: readonly number[];
  /** Seconds into the video at each beat, same length as `beats`. */
  times: readonly number[];
};

/**
 * Hookpad's own sync (`youtube.syncStart` / `syncEnd`, a document from the
 * live API): the section runs from `start` to `end` as FRACTIONS of the
 * video's length, beat 1 to `endBeat`. Needs the video's duration, known only
 * once a player has loaded it — see `resolveVideoFraction`.
 */
export type VideoFractionAlignment = {
  kind: "video-fraction";
  start: number;
  end: number;
  endBeat: number;
};

/** How a section lines up with its recording. `none`: it does not, so it is kept but never looped. */
export type Alignment =
  BeatTimesAlignment | VideoFractionAlignment | { kind: "none" };

/** A beat-times alignment's points: one per beat of one section, loaded whole. */
const BEAT_GRID_REASON =
  "one section's beat grid: a point per beat of the section";

/** An alignment on the wire or in a jsonb column. Checked only for shape: `beatTimesAlignment` checks the reading rules. */
export const AlignmentSchema: ZodParser<Alignment> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("beat-times"),
      beats: wholeList(z.number(), { reason: BEAT_GRID_REASON }),
      times: wholeList(z.number(), { reason: BEAT_GRID_REASON }),
    }),
    z.object({
      kind: z.literal("video-fraction"),
      start: z.number(),
      end: z.number(),
      endBeat: z.number(),
    }),
    z.object({ kind: z.literal("none") }),
  ],
);

/**
 * Build a beat-times alignment, checking what reading it relies on: at least
 * two points, one time per beat, beats strictly increasing. Throws otherwise —
 * every alignment in the Sheet Sage dump satisfies this, so a violation is a
 * broken assumption, not data to skip.
 */
export function beatTimesAlignment(
  beats: readonly number[],
  times: readonly number[],
): BeatTimesAlignment {
  if (beats.length < 2 || beats.length !== times.length) {
    throw new Error(
      `A beat-times alignment needs at least two points and one time per beat (got ${beats.length} beats, ${times.length} times)`,
    );
  }
  for (let i = 1; i < beats.length; i++) {
    if (!((beats[i] ?? NaN) > (beats[i - 1] ?? NaN))) {
      throw new Error(
        `A beat-times alignment's beats must strictly increase (beat ${beats[i]} after ${beats[i - 1]} at index ${i})`,
      );
    }
  }
  return { kind: "beat-times", beats, times };
}

/** A video-fraction alignment as a two-point beat-times one, once the video's length is known. */
export function resolveVideoFraction(
  alignment: VideoFractionAlignment,
  videoDurationSeconds: number,
): BeatTimesAlignment {
  return beatTimesAlignment(
    [1, alignment.endBeat],
    [
      alignment.start * videoDurationSeconds,
      alignment.end * videoDurationSeconds,
    ],
  );
}

/**
 * Seconds into the video at a Hookpad beat: linear between the two points
 * around it, and along the first or last segment outside them (Sheet Sage's
 * per-beat points can stop half a beat short of the section's end).
 *
 * Takes only a beat-times alignment, so a video-fraction one cannot be read
 * without its video's duration (`resolveVideoFraction` first), and a section
 * with no alignment cannot be read at all.
 */
export function beatToSeconds(
  alignment: BeatTimesAlignment,
  beat: number,
): number {
  const { beats, times } = alignment;
  let hi = 1;
  while (hi < beats.length - 1 && (beats[hi] ?? NaN) < beat) hi++;
  const b0 = beats[hi - 1] ?? NaN;
  const b1 = beats[hi] ?? NaN;
  const t0 = times[hi - 1] ?? NaN;
  const t1 = times[hi] ?? NaN;
  return t0 + ((beat - b0) * (t1 - t0)) / (b1 - b0);
}
