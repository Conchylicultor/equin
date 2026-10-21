import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { JsonlEventSchema } from "@plugins/conversations/plugins/transcript-source/core";

/**
 * One event of a transcript, as `jsonlEvents` pages it: its position in the
 * transcript (`seq`, 0 for the first event) and a stable `id`.
 *
 * The id is the tool-use id for a tool call — the identity a call keeps while
 * events before it come and go — and the position for everything else. Events
 * only ever append, except where a rewind cuts the tail, so a position names
 * the same event across changes; a row that does change in place (a tool call
 * whose result just landed) ships as one keyed upsert.
 */
export const TranscriptEventRowSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  event: JsonlEventSchema,
});
export type TranscriptEventRow = z.infer<typeof TranscriptEventRowSchema>;

/** Facts about the WHOLE transcript a window of it cannot answer. */
export const TranscriptMetaSchema = z.object({
  /** How many events the transcript has. */
  count: z.number().int(),
  /** The seq of its first assistant event (text, thinking or tool call); null before the agent answered. */
  firstAssistantSeq: z.number().int().nullable(),
});
export type TranscriptMeta = z.infer<typeof TranscriptMetaSchema>;

export const JsonlEventsQuerySchema = z.object({ id: z.string() });
export type JsonlEventsQuery = z.infer<typeof JsonlEventsQuerySchema>;

/** A seq as its order-key text: zero-padded, so text order is number order. */
export function seqKey(seq: number): string {
  return String(seq).padStart(9, "0");
}

/** Events per page: what a conversation opens on, and the step scrolling up loads. */
export const JSONL_EVENTS_PAGE = 200;

/** The most events one read without a viewport holds. */
export const JSONL_EVENTS_MAX = 5000;

/**
 * One conversation's parsed transcript chain, newest first, paged by position:
 * a conversation opens on its latest events, scrolling up loads older ones, and
 * a change ships only the rows it touched (an appended line is one row, a tool
 * result landing an upsert of its call) — never the whole transcript.
 *
 * Without a viewport a read holds at most `maxLimit` events; the largest
 * transcripts measured (50 MB, 5,000 lines) parse to under 2,000.
 *
 * `jsonlEvents.meta` answers what only the whole transcript knows
 * (`TranscriptMeta`). Not loaded yet is `pending` — never `[]`, which would read
 * as a conversation that has said nothing.
 */
export const jsonlEvents = liveValue("jsonl-events", {
  query: JsonlEventsQuerySchema,
  paged: {
    item: TranscriptEventRowSchema,
    id: "id",
    key: { of: (row) => [seqKey(row.seq)], order: ["desc"] },
    limit: JSONL_EVENTS_PAGE,
    maxLimit: JSONL_EVENTS_MAX,
    meta: TranscriptMetaSchema,
  },
});

/**
 * One tool call of a conversation's transcript, by its tool-use id — for a
 * surface outside the transcript (a pane opened from a call) that needs the
 * call whether or not any window of the transcript holds it. `null`: the
 * transcript has no such call.
 */
export const transcriptToolCall = liveValue("jsonl-events.tool-call", {
  schema: JsonlEventSchema.nullable(),
  params: ["id", "toolUseId"],
});

/**
 * Every user prompt of a conversation's transcript, as its rows (`jsonlEvents`'
 * ids and seqs) — so a window that opens in the middle of a long turn can still
 * pin the prompt that turn answers, which lies before it. Small (prompt text,
 * images by reference), and pushed only when a prompt is added.
 */
export const transcriptPrompts = liveValue("jsonl-events.prompts", {
  schema: z.array(TranscriptEventRowSchema),
  params: ["id"],
});
