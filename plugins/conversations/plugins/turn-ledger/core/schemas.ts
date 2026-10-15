import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";

/**
 * What a ledger row carries to the agent:
 * - `turn` — a message the user wrote (the prompt input, a template, Send);
 * - `answer` — an AskUserQuestion answer, typed once its menu is dismissed;
 * - `push-and-exit` — the configured wrap-up prompt.
 *
 * Only `turn` rows emit `conversation.userTurnSent`.
 */
export const TurnKindSchema = z.enum(["turn", "answer", "push-and-exit"]);
export type TurnKind = z.infer<typeof TurnKindSchema>;

/**
 * Where one turn stands. Every verdict comes from an event — the runtime's
 * submit check, the CLI's `UserPromptSubmit` hook, or Stop — never a timer.
 *
 * - `held` — the conversation was still `starting`; delivered once it can take
 *   input (as the launch message, or typed when its input box appears).
 * - `typing` — being typed into the agent's input box.
 * - `typed` — typed, and the box emptied after Enter: the CLI took the
 *   keystrokes. Waiting on the hook to say what it submitted — unless the row
 *   is `hookless`, where `typed` is final.
 * - `accepted` — the hook reported exactly this text (also for a busy agent:
 *   the hook fires at Enter, before the turn is dequeued).
 * - `merged` — the hook reported this text PLUS other text (a leftover draft
 *   the box still held); `extraText` is the rest.
 * - `returned` — Stop rewound it, or its text was found back in the input box:
 *   the CLI gave it back and the web draft is now its only copy.
 * - `failed` — it never reached the box (a tmux error, an input box that would
 *   not empty, a resume that was refused). Retry.
 * - `unverified` — typed, but the box never emptied after Enter. Retry; a late
 *   hook still resolves it.
 * - `withdrawn` — a `failed` / `unverified` turn the user took back into the
 *   draft instead of retrying (the card's Copy to draft); its error stays for
 *   history. A late hook matching it EXACTLY still makes it `accepted` (an
 *   unverified turn may have landed after all), unlike Stop's `returned`.
 *
 * A hook match always wins, over `failed` and `unverified` too.
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
 * and an exact hook (out of `withdrawn`), neither of which reopens it.
 */
export const SETTLED_TURN_STATES = [
  "accepted",
  "merged",
  "returned",
  "withdrawn",
] as const satisfies readonly TurnState[];

/**
 * One ledger row, as the web reads it (`turn-ledger.turns`), declared once as
 * fields: `conversationId` is the one a reader filters on; the rest is
 * carried.
 */
export const LEDGER_TURN_LISTED = {
  conversationId: textField({ label: "Conversation" }),
};

export const LEDGER_TURN_CARRIED = {
  id: textField(),
  kind: parsedTextField(TurnKindSchema, { default: "turn" }),
  /** What the user wrote, raw — for the draft and the echo. */
  text: textField(),
  state: parsedTextField(TurnStateSchema, { default: "held" }),
  /**
   * No hook will ever confirm this row — its session was launched without the
   * ledger's hook, or the text is a `/` command or `!` shell line, which the CLI
   * does not report. Its `typed` is final and means delivered.
   */
  hookless: boolField(),
  /** `merged` only: the text the CLI submitted around this turn's. */
  extraText: nullable(textField()),
  /** `failed` / `unverified` (and kept by `withdrawn`): why. */
  error: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
};

export const LedgerTurnSchema = fieldsToZodObject({
  ...LEDGER_TURN_LISTED,
  ...LEDGER_TURN_CARRIED,
});
export type LedgerTurn = z.infer<typeof LedgerTurnSchema>;
