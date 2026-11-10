import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * Away stretches of one pageview: when its tab was in the background
 * (`hidden`) or visible with nobody at it (`idle`), as offsets from the
 * pageview's start. They are what tells reading time from a tab left open.
 *
 * The tracker sends the whole list with every engagement beacon (cumulative,
 * like `engagedMs`); the server replaces the stored list with the newer one.
 */

/** Visible with no pointer / key / wheel / scroll / touch input (and no media playing) this long = idle. */
export const IDLE_AFTER_MS = 30_000;
/** Stretches shorter than this are dropped: a glance at another tab is not "away". */
export const MIN_GAP_MS = 5_000;
/** At most this many stretches per pageview; past it, the closest neighbours merge. */
export const MAX_GAPS = 20;
/** An offset past this (a tab open for a month) is clamped: a stuck tab, not a visit. */
export const MAX_GAP_OFFSET_MS = 30 * 24 * 60 * 60 * 1000;

export const GAP_KINDS = ["hidden", "idle"] as const;
export const GapKindSchema = z.enum(GAP_KINDS);
export type GapKind = z.infer<typeof GapKindSchema>;

const OffsetSchema = z.number().int().min(0).max(MAX_GAP_OFFSET_MS);

export const GapSchema = z
  .object({
    /** Offset from the pageview's start, ms. */
    startMs: OffsetSchema,
    endMs: OffsetSchema,
    kind: GapKindSchema,
  })
  .strict()
  .refine((g) => g.endMs >= g.startMs, {
    message: "gap ends before it starts",
  });
export type Gap = z.infer<typeof GapSchema>;

/** A pageview's stretches: in time order, never overlapping, at most {@link MAX_GAPS}. */
export const GapsSchema = cappedList(GapSchema, { max: MAX_GAPS }).refine(
  (gaps) => gaps.every((g, i) => i === 0 || g.startMs >= gaps[i - 1]!.endMs),
  { message: "gaps must be in order and must not overlap" },
);

/**
 * `gaps` with `gap` appended (it must start at or after the last one's end):
 * dropped when shorter than {@link MIN_GAP_MS}, and past {@link MAX_GAPS} the
 * two neighbours with the least time between them merge into one stretch —
 * the merge that misreports the least active time — keeping the kind of the
 * longer of the two. Never mutates `gaps`.
 */
export function appendGap(gaps: readonly Gap[], gap: Gap): Gap[] {
  const clamped: Gap = {
    kind: gap.kind,
    startMs: Math.min(MAX_GAP_OFFSET_MS, Math.max(0, Math.round(gap.startMs))),
    endMs: Math.min(MAX_GAP_OFFSET_MS, Math.max(0, Math.round(gap.endMs))),
  };
  if (clamped.endMs - clamped.startMs < MIN_GAP_MS) return [...gaps];
  const next = [...gaps, clamped];
  while (next.length > MAX_GAPS) {
    let best = 0;
    for (let i = 1; i < next.length - 1; i++)
      if (between(next, i) < between(next, best)) best = i;
    const a = next[best]!;
    const b = next[best + 1]!;
    next.splice(best, 2, {
      startMs: a.startMs,
      endMs: b.endMs,
      kind: a.endMs - a.startMs >= b.endMs - b.startMs ? a.kind : b.kind,
    });
  }
  return next;
}

const between = (gaps: readonly Gap[], i: number) =>
  gaps[i + 1]!.startMs - gaps[i]!.endMs;

/** Where a stretch list ends (0 for none): how far into the pageview it reaches. */
export function gapsExtentMs(gaps: readonly Gap[]): number {
  return gaps.at(-1)?.endMs ?? 0;
}
