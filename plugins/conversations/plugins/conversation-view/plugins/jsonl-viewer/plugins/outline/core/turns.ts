import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  JsonlEventSchema,
  type JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";

/**
 * One user turn of a transcript: its position, and the turn itself — without
 * its images (an outline entry is its first line), but with all its text, which
 * the page's `JsonlViewer.EventFilter` predicates read to decide whether the
 * turn is shown at all.
 */
export const OutlineTurnSchema = z.object({
  seq: z.number().int(),
  event: JsonlEventSchema,
});
export type OutlineTurn = z.infer<typeof OutlineTurnSchema>;

/** Every user turn of `events`, numbered from `firstSeq` (the seq of `events[0]`). */
export function userTurnsOf(
  events: readonly JsonlEvent[],
  firstSeq = 0,
): OutlineTurn[] {
  const turns: OutlineTurn[] = [];
  events.forEach((event, i) => {
    if (event.kind !== "user-text") return;
    const { segments: _segments, ...text } = event;
    turns.push({ seq: firstSeq + i, event: text });
  });
  return turns;
}

/**
 * A conversation's user turns, over its WHOLE transcript — the outline of a
 * conversation whose pane holds only its latest events. Small (a few KB of
 * prompt text), and pushed only when a turn is added.
 */
export const conversationTurns = liveValue("jsonl-viewer.outline.turns", {
  schema: z.array(OutlineTurnSchema),
  params: ["id"],
});
