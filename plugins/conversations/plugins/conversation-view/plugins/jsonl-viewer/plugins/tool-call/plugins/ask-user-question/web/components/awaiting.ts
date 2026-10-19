import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { isInterruptContent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { ANSWER_MARKER } from "../../shared";

/**
 * Locates the follow-up answer turn for a given AskUserQuestion tool-call:
 * scans forward from the tool-call, bounded by the next tool-call (the window
 * for this question), and returns the first `user-text` event whose trimmed
 * text starts with `ANSWER_MARKER`. A windowed, marker-keyed lookup — not a
 * blind positional scan. Returns the event (its `uuid` is what a rewind cuts
 * at), or null.
 */
export function findAnswerTurn(
  events: JsonlEvent[] | undefined,
  toolUseId: string,
): Extract<JsonlEvent, { kind: "user-text" }> | null {
  if (!events) return null;
  const startIdx = events.findIndex(
    (e) => e.kind === "tool-call" && e.toolUseId === toolUseId,
  );
  if (startIdx === -1) return null;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "tool-call") break; // window boundary: next tool-call
    if (e.kind === "user-text" && e.text.trim().startsWith(ANSWER_MARKER)) {
      return e;
    }
  }
  return null;
}

/**
 * Whether `toolCall` (an AskUserQuestion) is genuinely awaiting an answer in the
 * JSONL: it carries the interrupt/rejection-sentinel result, it is the most
 * recent tool call, no answer turn follows it, and the user has not moved on by
 * sending another message instead (a reply in place of the answer — the CLI
 * also writes the rejection then, followed by the user's own turn).
 *
 * This must NOT match a *past* question already answered from the web: that
 * one's result is permanently the interrupt sentinel too (the web-answer flow
 * cancels the tool first), but it has an answer turn after it and is usually no
 * longer the last tool-call.
 */
export function isAwaitingAnswer(
  events: JsonlEvent[],
  toolCall: Extract<JsonlEvent, { kind: "tool-call" }>,
): boolean {
  if (
    toolCall.result == null ||
    toolCall.result.isError !== true ||
    !isInterruptContent(toolCall.result.content)
  ) {
    return false;
  }
  const startIdx = events.findIndex(
    (e) => e.kind === "tool-call" && e.toolUseId === toolCall.toolUseId,
  );
  if (startIdx === -1) return false;
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    // Not the most recent tool call any more.
    if (e.kind === "tool-call") return false;
    // An answer turn (answered), or any other message the user sent (moved on)
    // — the CLI's own "[Request interrupted…]" line is neither.
    if (e.kind === "user-text" && !isInterruptContent(e.text)) return false;
  }
  return true;
}

/**
 * The AskUserQuestion whose inline answer form is (or should be) showing — the
 * most recent tool call, when it is awaiting an answer (`isAwaitingAnswer`).
 * Returns the awaiting event, or null.
 *
 * Hosts use this to decide whether the generic pending-prompt indicator should
 * defer to the card's own inline form, so the two never double up.
 */
export function findAwaitingAuqEvent(
  events: JsonlEvent[] | undefined,
): JsonlEvent | null {
  if (!events) return null;
  const lastToolCall = events.findLast((e) => e.kind === "tool-call");
  if (lastToolCall?.kind !== "tool-call") return null;
  if (lastToolCall.name !== "AskUserQuestion") return null;
  return isAwaitingAnswer(events, lastToolCall) ? lastToolCall : null;
}
