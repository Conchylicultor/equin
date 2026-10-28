import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { ResumeBlockedReasonSchema } from "./resume-outcome";

/** Background work (a subagent or a background shell) the model launched. */
export const BackgroundWorkSchema = z.object({
  toolUseId: z.string(),
  /** Tool that launched it — `Agent`, `Bash`, … */
  tool: z.string(),
  /** The model's own one-line description of the work, or "" when it gave none. */
  description: z.string(),
});
export type BackgroundWork = z.infer<typeof BackgroundWorkSchema>;

/**
 * What cutting a conversation before a message takes away that cannot be
 * brought back.
 *
 * A background report is delivered ONCE, into the conversation as it stood at
 * that moment. Cutting before the delivery loses it for good, and on the next
 * resume the CLI tells the model the work "didn't finish before the previous
 * session ended" — a false statement the user should see coming. Verified
 * against CLI 2.1.276; see
 * `research/2026-09-18-conversations-rewind-conversation.md`.
 */
export const CutLossesSchema = z.object({
  /** The user's own messages after the chosen one. */
  laterUserTurns: z.number().int(),
  /** Launched before the cut, reported after it: the report is lost. */
  lostReports: wholeList(BackgroundWorkSchema, {
    reason:
      "the background work one conversation launched before the cut — a handful, and the dialog names each",
  }),
  /**
   * Launched before the cut and never reported. Whether it is still running is
   * a fact about the live pane, not the transcript; if it is, restarting the
   * pane stops it.
   */
  unreported: wholeList(BackgroundWorkSchema, {
    reason:
      "the background work one conversation launched before the cut — a handful, and the dialog names each",
  }),
});
export type CutLosses = z.infer<typeof CutLossesSchema>;

/**
 * Why a transcript cannot be cut before a given message.
 * - `not-found` — no transcript line has this uuid.
 * - `not-a-live-user-prompt` — the line exists but is not a message the user
 *   typed, nor their answer to a question, on the conversation's live path.
 *
 * The first message is no refusal: going back to it starts the agent on a
 * fresh session (there is nothing to resume).
 */
export const CutRefusalSchema = z.enum(["not-found", "not-a-live-user-prompt"]);
export type CutRefusal = z.infer<typeof CutRefusalSchema>;

/**
 * Why a rewind was refused. Every one leaves the conversation exactly as it was.
 * - `no-transcript` — no session file on disk (never started, or aged out).
 * - `not-in-tail` — the message lives in an ancestor session file (the
 *   conversation was forked since). Only the file `claude --resume` reads can be
 *   rewound in place; "Fork from here" still works on such a message.
 * - the resume blockers — a rewind restarts the session, so whatever blocks a
 *   resume blocks it too.
 */
export const RewindRefusalSchema = z.enum([
  ...CutRefusalSchema.options,
  "no-transcript",
  "not-in-tail",
  ...ResumeBlockedReasonSchema.options,
]);
export type RewindRefusal = z.infer<typeof RewindRefusalSchema>;

const RefusedSchema = z.object({
  ok: z.literal(false),
  reason: RewindRefusalSchema,
  /** Plain-language explanation, ready to show. */
  message: z.string(),
});

/** What rewinding to this message would do — and would lose. */
export const RewindPreviewSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    messageText: z.string(),
    losses: CutLossesSchema,
    /** A rewind in place is possible (the message is in the live session file). */
    inPlace: z.boolean(),
    /** The agent is mid-turn: rewinding in place stops it. */
    turnRunning: z.boolean(),
  }),
  RefusedSchema,
]);
export type RewindPreview = z.infer<typeof RewindPreviewSchema>;

export const RewindOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** Text of the removed message, for the prompt editor. */
    rewindText: z.string(),
  }),
  RefusedSchema,
]);
export type RewindOutcome = z.infer<typeof RewindOutcomeSchema>;
