import { useSyncExternalStore } from "react";
import type { FormAnswer, Question } from "./answer-model";

// ---------------------------------------------------------------------------
// The answers THIS tab sent whose result the transcript does not hold yet —
// the optimistic echo of a held question's answer. Without it the question
// vanished on Submit (the relay row leaves its collection at once, the
// transcript card stays out while the call is held) and came back seconds
// later once the CLI wrote the result. With it, the card shows the answer
// the instant it is sent, "Sending…" under it, until the transcript takes over
// (the same contract as a user message's echo — conversation-view/pending-turn).
//
// Keyed by tool-use id (unique across conversations). Written by whoever
// sends the answer (the question relay's held form), read by both surfaces
// that draw the question in turn: the `"question"` pending prompt while the
// call is held, then the transcript card until its result lands — which drops
// the entry. A failed send drops it too, so the form comes back with the
// user's picks (the form clears its draft only on success).
//
// In memory, per tab: nothing to recover after a reload — an answer the agent
// got is in the transcript, and one it did not is still in the form's draft.
// ---------------------------------------------------------------------------

export interface SentAnswer {
  questions: Question[];
  answer: FormAnswer;
}

const sent = new Map<string, SentAnswer>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Records an answer as sent: both question surfaces draw it at once. */
export function recordSentAnswer(toolUseId: string, entry: SentAnswer): void {
  sent.set(toolUseId, entry);
  notify();
}

/** Forgets a sent answer — its send failed, or the transcript now holds it. */
export function dropSentAnswer(toolUseId: string): void {
  if (sent.delete(toolUseId)) notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The answer this tab sent for a call, still on its way; null when none. */
export function useSentAnswer(toolUseId: string): SentAnswer | null {
  return useSyncExternalStore(
    subscribe,
    () => sent.get(toolUseId) ?? null,
    () => null,
  );
}
