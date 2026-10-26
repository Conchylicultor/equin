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
 * send, the agent's confirmation (`turn_started`: its CLI started the turn),
 * the agent going away, or Stop — never a timer.
 *
 * - `held` — the conversation was still `starting`; delivered once the agent
 *   can take it (as the launch prompt, or sent once it is up).
 * - `typing` — being sent to the agent.
 * - `typed` — the agent's socket took it; waiting on its CLI to start it. A
 *   busy agent's CLI holds it in its command queue until the next tool
 *   boundary or the turn's end: the web shows it as Queued.
 * - `accepted` — the agent confirmed taking THIS turn: its `turn_started`
 *   echoed the row's id when its CLI started it (for a busy agent: at the
 *   next tool boundary or the turn's end).
 * - `returned` — Stop rewound it: the agent gave it back and the web draft is
 *   now its only copy.
 * - `failed` — it never reached the agent (a resume that was refused, a socket
 *   error), or the agent went away before its CLI started it. Retry.
 * - `withdrawn` — a `failed` turn the user took back into the draft instead
 *   of retrying (the card's Copy to draft); its error stays for history. A
 *   late confirmation of it still makes it `accepted` (the agent's word is the
 *   truth), unlike Stop's `returned`.
 *
 * A confirmation always wins, over `failed` too.
 */
export const TurnStateSchema = z.enum([
  "held",
  "typing",
  "typed",
  "accepted",
  "returned",
  "failed",
  "withdrawn",
]);
export type TurnState = z.infer<typeof TurnStateSchema>;

/** The states a user may Retry from. */
export const RETRYABLE_TURN_STATES = [
  "failed",
] as const satisfies readonly TurnState[];

/**
 * The states whose outcome is decided — swept by retention a week later. Only
 * two late facts still move one: Stop's `returned` (out of `accepted`) and a
 * confirmation (out of `withdrawn`), neither of which reopens it.
 */
export const SETTLED_TURN_STATES = [
  "accepted",
  "returned",
  "withdrawn",
] as const satisfies readonly TurnState[];
