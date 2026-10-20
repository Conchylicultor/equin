import type { TurnState } from "../../core/schemas";

// The ledger's whole state machine, as one pure function: what an event does
// to a row. Every writer (the send path, the hook mailbox, Stop, Retry) goes
// through `applyTurnEvent` (store.ts), which locks the row, asks this, and
// writes the answer — so the rules below are the only place a state changes.
//
// The rules that make it safe to apply events in whatever order they arrive:
//
//   - A hook match always wins. The CLI saying "I submitted this" is the one
//     ground truth, so it resolves `typing`, `typed`, `unverified` and `failed`
//     alike — it can land before the send path has even recorded `typed` (the
//     hook fires at Enter, inside typeTurn's own wait).
//   - Never revert. Once accepted or merged, the send path's own verdicts
//     (`typed`, `unverified`, `failed`) change nothing; only Stop's `returned`
//     moves a settled row, because the CLI really did hand the text back.
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
 * - `typed` / `unverified` — the runtime's submit check, with whether the
 *   session reports its prompts at all (`hookless`: launched without the
 *   ledger's hook). A row already hookless by its text stays so.
 * - `failed` — the text never reached the box.
 * - `hook` — the CLI's `UserPromptSubmit` reported `prompt`, `at` the moment
 *   it fired (the mailbox file's mtime — not when the drain got to it).
 * - `returned` — the CLI gave the text back (Stop, or found in the box).
 * - `withdraw` — the user took a `failed` / `unverified` turn back into the
 *   draft instead of retrying it: the draft is now its only copy.
 */
export type TurnEvent =
  | { kind: "hold" }
  | { kind: "deliver"; typedText: string }
  | { kind: "release"; typedText: string }
  | { kind: "typed"; hookless: boolean }
  | { kind: "unverified"; hookless: boolean; reason: string }
  | { kind: "failed"; error: string }
  | { kind: "hook"; prompt: string; at: Date }
  | { kind: "returned" }
  | { kind: "withdraw" };

/** The row fields a transition reads. */
export interface TurnFacts {
  state: TurnState;
  typedText: string;
  hookless: boolean;
}

/** The row fields a transition may write, beside `state`. */
export interface TurnPatch {
  typedText?: string;
  hookless?: boolean;
  submittedText?: string;
  submittedAt?: Date;
  extraText?: string | null;
  error?: string | null;
}

export interface TurnTransition {
  state: TurnState;
  patch: TurnPatch;
}

/** How the CLI's submitted prompt relates to a row's typed text. */
export type PromptMatch =
  | { kind: "equal" }
  | { kind: "contains"; extraText: string }
  | { kind: "none" };

/**
 * Compare the hook's `prompt` with what was typed. Byte-exact (Step 1, E1: the
 * hook's prompt is the box's text verbatim — multi-line, a leading `>`, `@`
 * tokens), save for whitespace at the two ends: the launch message reaches the
 * CLI with a leading space before a `/` (the retired tmux runtime's
 * launch-message.ts did that), and nothing else about a turn depends on edge whitespace.
 *
 * `contains` is the incident's shape: a stale draft the box still held, with
 * the turn typed after it, submitted as ONE prompt.
 */
export function matchPrompt(prompt: string, typedText: string): PromptMatch {
  const submitted = prompt.trim();
  const typed = typedText.trim();
  if (typed.length === 0) return { kind: "none" };
  if (submitted === typed) return { kind: "equal" };
  const at = submitted.indexOf(typed);
  if (at === -1) return { kind: "none" };
  const extraText = [
    submitted.slice(0, at).trim(),
    submitted.slice(at + typed.length).trim(),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
  return { kind: "contains", extraText };
}

/**
 * Which rows a submitted `prompt` may resolve, in the order to try them (rows
 * given oldest first). Sends are serialized per conversation, so the
 * unconfirmed rows are few and in order:
 *
 *   1. every EQUAL match, oldest first;
 *   2. then every row the prompt CONTAINS (a merge) — but never a `failed`
 *      one: a turn that never reached the box cannot have been merged into
 *      somebody else's prompt.
 *
 * `prompt_id` is no turn id (a busy agent's queued turn carries the running
 * turn's), so text is the key. Hookless rows are never candidates.
 */
export function promptCandidates<T extends TurnFacts>(
  prompt: string,
  oldestFirst: readonly T[],
): T[] {
  const open = oldestFirst.filter(
    (row) => !row.hookless && HOOK_ROLE[row.state] === "open",
  );
  const withdrawn = oldestFirst.filter(
    (row) => !row.hookless && HOOK_ROLE[row.state] === "exact",
  );
  return [
    ...open.filter(
      (row) => matchPrompt(prompt, row.typedText).kind === "equal",
    ),
    ...open.filter(
      (row) =>
        row.state !== "failed" &&
        matchPrompt(prompt, row.typedText).kind === "contains",
    ),
    // Last, and only exactly: a turn the user already took back loses to any
    // turn still on its way.
    ...withdrawn.filter(
      (row) => matchPrompt(prompt, row.typedText).kind === "equal",
    ),
  ];
}

/**
 * What a hook may still do to a row in each state (see "a hook match always
 * wins"): `open` — resolve it, equal or merged; `exact` — resolve it only on an
 * exact match, after every open row (`withdrawn`: the user took it back, but
 * it may have landed after all — the truth wins); `null` — nothing (settled,
 * or not typed yet). A Record, so a new state cannot be left out.
 */
const HOOK_ROLE: Record<TurnState, "open" | "exact" | null> = {
  held: null,
  typing: "open",
  typed: "open",
  accepted: null,
  merged: null,
  // Stop's / the box's: the CLI handed the text back; a hook for that text
  // belongs to whatever turn carries it next.
  returned: null,
  failed: "open",
  unverified: "open",
  withdrawn: "exact",
};

/** The states a hook may still resolve — the mailbox's candidate query. */
export const HOOK_RESOLVABLE_STATES = (
  Object.keys(HOOK_ROLE) as TurnState[]
).filter((state) => HOOK_ROLE[state] !== null);

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
      return state === "held" || state === "failed" || state === "unverified"
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
      return state === "typing"
        ? {
            state: "typed",
            patch: { hookless: row.hookless || event.hookless },
          }
        : null;
    case "unverified":
      return state === "typing"
        ? {
            state: "unverified",
            patch: {
              hookless: row.hookless || event.hookless,
              error: event.reason,
            },
          }
        : null;
    case "failed":
      return state === "typing" || state === "held"
        ? { state: "failed", patch: { error: event.error } }
        : null;
    case "hook": {
      const role = HOOK_ROLE[state];
      if (role === null) return null;
      const match = matchPrompt(event.prompt, row.typedText);
      if (match.kind === "none") return null;
      if (role === "exact" && match.kind !== "equal") return null;
      if (match.kind === "equal") {
        return {
          state: "accepted",
          patch: { submittedAt: event.at, error: null },
        };
      }
      return {
        state: "merged",
        patch: {
          submittedText: event.prompt,
          submittedAt: event.at,
          extraText: match.extraText,
          error: null,
        },
      };
    }
    case "returned":
      return state === "typed" || state === "accepted" || state === "merged"
        ? { state: "returned", patch: {} }
        : null;
    case "withdraw":
      // The error stays, for the history of why it was taken back.
      return state === "failed" || state === "unverified"
        ? { state: "withdrawn", patch: {} }
        : null;
  }
}
