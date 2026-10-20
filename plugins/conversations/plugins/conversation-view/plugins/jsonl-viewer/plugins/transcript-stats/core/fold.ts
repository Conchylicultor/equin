import { z } from "zod";
import type { LiveValue } from "@plugins/network/plugins/live/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * The params of a fold's `before` value: the conversation, and the seq the
 * fold stops before (a decimal). Declared by each stat with its own literal
 * key: `liveValue("…", { schema, params: TRANSCRIPT_FOLD_PARAMS })`.
 */
export const TRANSCRIPT_FOLD_PARAMS = {
  id: z.string(),
  before: z.string().regex(/^\d+$/),
};

/**
 * A stat's reading as a fold over the transcript, event by event: a state to
 * start from and a pure step. Resumable by construction — the fold of a prefix
 * continues from where it stopped — which is what lets a stat read "the
 * transcript up to the row on screen" when the page holds only the latest
 * window: the server folds everything before the window (`before`, one small
 * value no appended line changes), the page continues it over the loaded rows
 * up to the reader.
 */
export interface TranscriptFold<S> {
  init: () => S;
  step: (state: S, event: JsonlEvent) => S;
  /** The fold of a conversation's transcript up to (not including) seq `before`; served by `serveTranscriptFold`. */
  before: LiveValue<S, { id: string; before: string }>;
}

/** Fold `events` from `state`. */
export function foldEvents<S>(
  fold: Pick<TranscriptFold<S>, "step">,
  state: S,
  events: readonly JsonlEvent[],
): S {
  let s = state;
  for (const event of events) s = fold.step(s, event);
  return s;
}
