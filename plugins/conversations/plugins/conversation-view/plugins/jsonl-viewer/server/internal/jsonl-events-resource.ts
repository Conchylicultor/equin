import { serveValue, sliceRange } from "@plugins/network/plugins/live/server";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  followedTranscriptChain,
  transcriptChainFollows,
} from "@plugins/conversations/plugins/transcript-source/server";
import {
  jsonlEvents,
  transcriptPrompts,
  transcriptToolCall,
  type TranscriptEventRow,
  type TranscriptMeta,
} from "../../core";
import {
  conversationEvents,
  derivedFromEvents,
  watchConversationEvents,
} from "./conversation-events";
import { serveTranscriptValue } from "./transcript-value";

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
// schedules slices memory. The chain's facts are followed
// (`transcriptChainFollows`): a session recorded on this conversation re-reads
// its own question's pages alone.
export const jsonlEventsServed = serveValue(jsonlEvents, {
  source: "external",
  changes: "notified",
  follows: (follow) => transcriptChainFollows(follow),
  loader: async ({ id }, range, { followed }) =>
    sliceRange(
      jsonlEvents,
      transcriptRows(
        await conversationEvents(id, followedTranscriptChain(followed)),
      ),
      range,
    ),
  meta: async ({ id }, { followed }) =>
    transcriptMeta(
      await conversationEvents(id, followedTranscriptChain(followed)),
    ),
  // Watch the conversation's transcript while any page of it is on screen
  // (once per question, however its pages split).
  whileSubscribed: (query, notify) => watchConversationEvents(query.id, notify),
});

// One tool call by id, from the same events — notified only when the call
// itself moved (its result lands), not on every line appended after it.
const toolCall = derivedFromEvents(
  ({ id, toolUseId }: { id: string; toolUseId: string }) =>
    `${id}\u0000${toolUseId}`,
  ({ toolUseId }, events) =>
    events.find((e) => e.kind === "tool-call" && e.toolUseId === toolUseId) ??
    null,
);

export const transcriptToolCallServed = serveValue(transcriptToolCall, {
  source: "external",
  changes: "notified",
  follows: (follow) => transcriptChainFollows(follow),
  loader: async (params, { followed }) =>
    toolCall.load(
      params,
      await conversationEvents(params.id, followedTranscriptChain(followed)),
    ),
  whileSubscribed: (params, notify) => toolCall.watch(params, notify),
});

// Every prompt, with the same ids the pages give it — so the view can draw a
// prompt before its window and have the page's own row take over unchanged.
export const transcriptPromptsServed = serveTranscriptValue(
  transcriptPrompts,
  (events) =>
    transcriptRows(events).filter((row) => row.event.kind === "user-text"),
);
