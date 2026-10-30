import type { TurnState } from "../../core";

// The ledger's whole state machine, as one pure function: what an event does
// to a row. Every writer (the send path, the agent's confirmation, Stop, Retry) goes
// through `applyTurnEvent` (store.ts), which locks the row, asks this, and
// writes the answer — so the rules below are the only place a state changes.
//
// The rules that make it safe to apply events in whatever order they arrive:
//
//   - A confirmation always wins. The agent saying "I took turn <id>" (its
//     `turn_started` event, echoing the id the backend sent the turn with) is
//     the one ground truth, so it resolves that row out of `held`, `typing`,
//     `typed`, `failed` and `withdrawn` alike — it can land before the send
//     path has even recorded `typed`.
//   - Never revert. Once accepted, the send path's own verdicts (`typed`,
//     `failed`) change nothing; only `returned` moves a settled row, because
//     the agent really did hand the turn back.
//   - An event that does not apply returns null: no write, so applying the
//     same event twice is a no-op (the fixed point the tests pin).

/**
 * What can happen to a turn.
 *
 * - `hold` — the send found the conversation `starting` (a resume put it
 *   there): wait for the input box.
 * - `deliver` — a held or retried row starts being typed, as `typedText`.
 * - `release` — the launch that was to carry a held row threw before the
 *   agent existed: it is held again, as `typedText`.
 * - `typed` — the agent's socket queued it.
 * - `failed` — it never reached the agent.
 * - `confirmed` — the agent's CLI started THIS turn (its `turn_started`
 *   event carried the row's id), as the transcript line `promptUuid`, `at` the
 *   moment it did.
 * - `confirmed-by-text` — TEMPORARY: the agent reported taking `prompt`
 *   without an id — an agent started before turn ids, whose launch prompt
 *   carries none. Resolves a row whose typed text IS the prompt
 *   (`promptIs`). Deleted, with `resolvePromptSubmit`, once no agent started
 *   before turn ids runs (the sdk projection's `turn_ids` false on no live row).
 * - `dropped` — the agent went away while the turn waited in its CLI's
 *   queue: it never ran. Fails it (Retry); a late confirmation still wins.
 * - `returned` — the turn came back to the user: Stop took it back out of the
 *   session, a rewind cut it, or Stop took a `held` turn back before the agent
 *   it was waiting for was up.
 * - `withdraw` — the user took a `failed` turn back into the draft instead of
 *   retrying it: the draft is now its only copy.
 */
export type TurnEvent =
  | { kind: "hold" }
  | { kind: "deliver"; typedText: string }
  | { kind: "release"; typedText: string }
  | { kind: "typed" }
  | { kind: "failed"; error: string }
  | { kind: "confirmed"; promptUuid: string; at: Date }
  | {
      kind: "confirmed-by-text";
      prompt: string;
      promptUuid: string;
      at: Date;
    }
  | { kind: "dropped" }
  | { kind: "returned" }
  | { kind: "withdraw" };

/** The row fields a transition reads. */
export interface TurnFacts {
  state: TurnState;
  typedText: string;
}

/** The row fields a transition may write, beside `state`. */
export interface TurnPatch {
  typedText?: string;
  submittedAt?: Date;
  promptUuid?: string;
  error?: string | null;
}

export interface TurnTransition {
  state: TurnState;
  patch: TurnPatch;
}

/**
 * Whether the prompt an id-less confirmation names is `typedText` — byte-exact
 * save for whitespace at the two ends.
 *
 * Temporary, like `confirmed-by-text`: the launch prompt of an agent started
 * before turn ids is the one confirmation that carries no id, and it is one
 * whole turn (a turn is its own SDK user message — nothing merges two).
 */
export function promptIs(prompt: string, typedText: string): boolean {
  const typed = typedText.trim();
  return typed.length > 0 && prompt.trim() === typed;
}

/**
 * Which rows a confirmation resolves (see "a confirmation always wins"):
 * every row not settled. `held` too — a launch that threw after its agent had
 * taken the prompt puts the row back to `held`; the agent's word is the truth,
 * and accepting it keeps the flush from sending it a second time. Settled rows
 * (`accepted`, `returned`) stay: replaying the line is a no-op, and Stop's
 * `returned` is the agent handing the turn back after taking it.
 * A Record, so a new state cannot be left out.
 */
const CONFIRMABLE: Record<TurnState, boolean> = {
  held: true,
  typing: true,
  typed: true,
  accepted: false,
  returned: false,
  failed: true,
  withdrawn: true,
};

/** The states a confirmation may still resolve — `resolvePromptSubmit`'s candidate query. */
export const CONFIRMABLE_STATES = (
  Object.keys(CONFIRMABLE) as TurnState[]
).filter((state) => CONFIRMABLE[state]);

function accept(event: { promptUuid: string; at: Date }): TurnTransition {
  return {
    state: "accepted",
    patch: { submittedAt: event.at, promptUuid: event.promptUuid, error: null },
  };
}

/** The next state for `event`, or null when the event changes nothing. */
export function transitionTurn(
  row: TurnFacts,
  event: TurnEvent,
): TurnTransition | null {
  const { state } = row;
  switch (event.kind) {
    case "hold":
      return state === "typing" ? { state: "held", patch: {} } : null;
    case "deliver":
      return state === "held" || state === "failed"
        ? {
            state: "typing",
            patch: { typedText: event.typedText, error: null },
          }
        : null;
    case "release":
      return state === "typing"
        ? { state: "held", patch: { typedText: event.typedText } }
        : null;
    case "typed":
      return state === "typing" ? { state: "typed", patch: {} } : null;
    case "failed":
      return state === "typing" || state === "held"
        ? { state: "failed", patch: { error: event.error } }
        : null;
    case "confirmed":
      return CONFIRMABLE[state] ? accept(event) : null;
    case "confirmed-by-text":
      return CONFIRMABLE[state] && promptIs(event.prompt, row.typedText)
        ? accept(event)
        : null;
    case "dropped":
      return state === "typed"
        ? {
            state: "failed",
            patch: {
              error: "the agent stopped before it took this message",
            },
          }
        : null;
    case "returned":
      return state === "held" || state === "typed" || state === "accepted"
        ? { state: "returned", patch: {} }
        : null;
    case "withdraw":
      // The error stays, for the history of why it was taken back.
      return state === "failed" ? { state: "withdrawn", patch: {} } : null;
  }
}
