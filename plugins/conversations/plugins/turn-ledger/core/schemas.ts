import { z } from "zod";

/**
 * What a ledger row carries to the agent:
 * - `turn` — a message the user wrote (the prompt input, a template, Send);
 * - `answer` — an AskUserQuestion answer, typed once its menu is dismissed;
 * - `push-and-exit` — the configured wrap-up prompt;
 * - `launch` — the prompt a conversation was launched with, recorded with the
 *   conversation itself and delivered as its launch message — so it echoes
 *   from the moment the conversation exists, like any held turn.
 *
 * Only `turn` rows emit `conversation.userTurnSent` (a launch's prompt is
 * already announced by `conversationCreated`).
 */
export const TurnKindSchema = z.enum([
  "turn",
  "answer",
  "push-and-exit",
  "launch",
]);
export type TurnKind = z.infer<typeof TurnKindSchema>;

/**
 * Where one turn stands. Every verdict comes from an event — the runtime's
 * send, the agent's confirmation (`turn_started`: it took the turn off its
 * input queue), or Stop — never a timer.
 *
 * - `held` — the conversation was still `starting`; delivered once the agent
 *   can take it (as the launch prompt, or sent once it is up).
 * - `typing` — being sent to the agent.
 * - `typed` — the agent's socket took it; waiting on the agent to confirm it
 *   took it off its queue.
 * - `accepted` — the agent confirmed exactly this text (also for a busy agent:
 *   it confirms when the turn is dequeued).
 * - `merged` — the agent confirmed this text PLUS other text; `extraText` is
 *   the rest.
 * - `returned` — Stop rewound it: the agent gave it back and the web draft is
 *   now its only copy.
 * - `failed` — it never reached the agent (a resume that was refused, a socket
 *   error). Retry.
 * - `unverified` — sent, but the runtime cannot tell whether it went in.
 *   Retry; a late confirmation still resolves it.
 * - `withdrawn` — a `failed` / `unverified` turn the user took back into the
 *   draft instead of retrying (the card's Copy to draft); its error stays for
 *   history. A late confirmation matching it EXACTLY still makes it `accepted`
 *   (an unverified turn may have landed after all), unlike Stop's `returned`.
 *
 * A confirmation always wins, over `failed` and `unverified` too.
 */
export const TurnStateSchema = z.enum([
  "held",
  "typing",
  "typed",
  "accepted",
  "merged",
  "returned",
  "failed",
  "unverified",
  "withdrawn",
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

/** The states a user may Retry from. */
export const RETRYABLE_TURN_STATES = [
  "failed",
  "unverified",
] as const satisfies readonly TurnState[];

/**
 * The states whose outcome is decided — swept by retention a week later. Only
 * two late facts still move one: Stop's `returned` (out of accepted / merged)
 * and an exact confirmation (out of `withdrawn`), neither of which reopens it.
 */
export const SETTLED_TURN_STATES = [
  "accepted",
  "merged",
  "returned",
  "withdrawn",
] as const satisfies readonly TurnState[];
