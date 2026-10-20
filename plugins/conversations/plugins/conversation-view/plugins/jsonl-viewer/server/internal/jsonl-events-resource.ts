import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  jsonlEvents,
  transcriptToolCall,
  type TranscriptEventRow,
  type TranscriptMeta,
} from "../../core";
import {
  conversationEvents,
  watchConversationEvents,
} from "./conversation-events";

// Rows are derived once per events array (the memo hands out the same array
// until the transcript changes), so every page of one change slices one list.
const rowsByEvents = new WeakMap<readonly JsonlEvent[], TranscriptEventRow[]>();

/**
 * The transcript's events as rows: a tool call keyed by its tool-use id (it
 * keeps that identity while events before it change), anything else by its
 * position. A tool-use id seen twice (an orphan result's empty id) falls back
 * to the position, so ids stay unique.
 */
export function transcriptRows(
  events: readonly JsonlEvent[],
): TranscriptEventRow[] {
  const cached = rowsByEvents.get(events);
  if (cached) return cached;
  const seenToolIds = new Set<string>();
  const rows = events.map((event, seq): TranscriptEventRow => {
    if (
      event.kind === "tool-call" &&
      event.toolUseId !== "" &&
      !seenToolIds.has(event.toolUseId)
    ) {
      seenToolIds.add(event.toolUseId);
      return { id: `tool:${event.toolUseId}`, seq, event };
    }
    return { id: `s${seq}`, seq, event };
  });
  rowsByEvents.set(events, rows);
  return rows;
}

export function transcriptMeta(events: readonly JsonlEvent[]): TranscriptMeta {
  const firstAssistant = events.findIndex(
    (e) =>
      e.kind === "assistant-text" ||
      e.kind === "assistant-thinking" ||
      e.kind === "tool-call",
  );
  return {
    count: events.length,
    firstAssistantSeq: firstAssistant === -1 ? null : firstAssistant,
  };
}

// Paged: a page is a keyed window, so a change ships the rows it touched — an
// appended line is one row — instead of the whole transcript. Every page and
// the meta read the conversation's events (conversation-events.ts: one memo,
// primed by one watch before anything is notified), so the recompute `notify`
// schedules slices memory.
export const jsonlEventsServed = serveValue(jsonlEvents, {
  source: "external",
  changes: "notified",
  loader: async ({ id }, range) =>
    sliceRange(
      jsonlEvents,
      transcriptRows(await conversationEvents(id)),
      range,
    ),
  meta: async ({ id }) => transcriptMeta(await conversationEvents(id)),
  // Watch the conversation's transcript while any page of it is on screen
  // (once per question, however its pages split).
  whileSubscribed: (query, notify) => watchConversationEvents(query.id, notify),
});

// One tool call by id, from the same events. Events are rebuilt on every
// change, so an unchanged call is handed back as the object last served —
// which the runtime sends as nothing; it is pushed only when it changes (its
// result lands).
const lastToolCall = new Map<
  string,
  { json: string; value: JsonlEvent | null }
>();
const toolCallKey = (id: string, toolUseId: string) =>
  `${id}\u0000${toolUseId}`;

export const transcriptToolCallServed = serveValue(transcriptToolCall, {
  source: "external",
  changes: "notified",
  loader: async ({ id, toolUseId }) => {
    const call =
      (await conversationEvents(id)).find(
        (e) => e.kind === "tool-call" && e.toolUseId === toolUseId,
      ) ?? null;
    const key = toolCallKey(id, toolUseId);
    const json = JSON.stringify(call);
    const previous = lastToolCall.get(key);
    if (previous?.json === json) return previous.value;
    lastToolCall.set(key, { json, value: call });
    return call;
  },
  whileSubscribed: (params, notify) => {
    const stop = watchConversationEvents(params.id, notify);
    return () => {
      stop();
      lastToolCall.delete(toolCallKey(params.id, params.toolUseId));
    };
  },
});
