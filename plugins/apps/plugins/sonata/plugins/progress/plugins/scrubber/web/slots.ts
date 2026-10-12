import type { ComponentType, ReactNode } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";

/** A beat range along the song, `[start, end)`. */
export type BeatSpan = { start: number; end: number };

/**
 * One item of the label lane under the rail. Items sharing a `beat` (across
 * every contributor) render inline in one group, in contribution `order` — so
 * a key that changes where a section starts reads inside that section's label
 * without either contributor knowing about the other.
 *
 * A group spans from its beat to the next group's and is one hover target: it
 * highlights across its whole width, thickens the rail segment it sits on, and
 * is a `hoverRevealGroup` — so an item can stay hidden until the group is
 * hovered (`hoverRevealTarget`, e.g. a "loop this section" button).
 */
export type ProgressLabel = {
  /** Where the label anchors; also the grouping key. */
  beat: number;
  /** React key, unique within its contributor. */
  key: string;
  node: ReactNode;
  /** `"end"` pins the item to the group's right edge (after every start item). */
  align?: "end";
};

/**
 * The open timeline axis of the Sonata progress bar. The scrubber owns the
 * generic surface (rail, label lane, hover preview) and never names a
 * contributor; adding/removing a marker, chapter, label or description plugin
 * is zero edits here. All are plain `defineSlot`s read with
 * `useContributions()` — NOT reorderable lists.
 */
export const SonataProgress = {
  /** Absolutely-positioned overlays over the rail zone (ticks, lines, loop). */
  Marker: defineSlot<{
    id: string;
    component: ComponentType<{
      score: Score;
      /** beat → [0,1] position along the track. */
      beatToFraction: (beat: number) => number;
    }>;
  }>({ docLabel: (p) => p.id }),

  /**
   * How the rail is split into segments ("chapters"). The scrubber uses the
   * first contributor returning a non-empty list; none → one segment.
   */
  Chapters: defineSlot<{
    id: string;
    chapters: (score: Score) => readonly BeatSpan[];
  }>({ docLabel: (p) => p.id }),

  /** Items of the label lane under the rail, grouped by beat. */
  Label: defineSlot<{
    id: string;
    /** Position within a same-beat group (lower first). */
    order: number;
    labels: (score: Score) => readonly ProgressLabel[];
  }>({ docLabel: (p) => p.id }),

  /**
   * Lines of the hover preview. `head` items follow the time on the first
   * line, `body` items form the second line, each in `order`. `snapBeats`
   * (optional) are beats the hover position snaps onto when the pointer is
   * within a few px — the preview only; a seek is never snapped.
   */
  Describe: defineSlot<{
    id: string;
    order: number;
    line: "head" | "body";
    describe: (score: Score, beat: number) => ReactNode;
    snapBeats?: (score: Score) => readonly number[];
  }>({ docLabel: (p) => p.id }),
};
