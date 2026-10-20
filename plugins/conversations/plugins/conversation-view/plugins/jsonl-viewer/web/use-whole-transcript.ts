import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type { LiveValue } from "@plugins/network/plugins/live/core";
import {
  readyResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useTranscriptDrawn } from "./components/transcript-events-context";
import { useJsonlConversationId } from "./components/conversation-id-context";

/**
 * A fact about the WHOLE transcript the enclosing `TranscriptView` draws — an
 * outline, a total, an aggregate — whichever part of it is loaded.
 *
 * A whole transcript (a sub-agent's pane) is derived here; a window of a
 * longer one (a conversation's pane, which holds its latest events) is read
 * from `value`, which the owner serves with `serveTranscriptValue(value,
 * derive)` — the SAME `derive`, run on the server over every event. One
 * function, so the two cannot disagree.
 */
export function useWholeTranscript<T>(
  value: LiveValue<T, { id: string }>,
  derive: (events: readonly JsonlEvent[]) => T,
): ResourceResult<T> {
  const drawn = useTranscriptDrawn();
  const conversationId = useJsonlConversationId();
  const windowed = drawn.older !== null;
  if (windowed && conversationId === null) {
    throw new Error("a transcript window is drawn outside its conversation");
  }
  const served = useLive(
    value,
    windowed && conversationId !== null ? { id: conversationId } : null,
  );
  const local = useMemo(
    () => (windowed ? null : derive(drawn.events)),
    // `derive` is a module-level function by contract (a stable identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, drawn.events],
  );
  return useMemo(
    (): ResourceResult<T> => (windowed ? served : readyResource(local as T)),
    [windowed, served, local],
  );
}
