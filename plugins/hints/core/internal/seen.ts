import { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * How the user left a hint or a tour: acted on the tip's target, dismissed it
 * (× / Got it / Esc), completed the tour, or skipped it ("I'll explore on my
 * own"). Recorded so a later "Your tips" tracker can tell acting from
 * dismissing.
 */
export const HINT_OUTCOMES = [
  "acted",
  "dismissed",
  "completed",
  "skipped",
] as const;
export const HintOutcomeSchema = z.enum(HINT_OUTCOMES);
export type HintOutcome = z.infer<typeof HintOutcomeSchema>;

/**
 * One seen hint or tour. `outcome` is null while a tour is still running (its
 * id is marked seen when it STARTS, so a reload mid-tour never restarts it;
 * the outcome lands when it ends).
 */
export const hintSeenFields = {
  /**
   * The declared hint or tour id. Named `hintId`, not `id`: it is a name a
   * plugin wrote in code (`defineHint({ id })`), not a minted record id, so it
   * has no id kind.
   */
  hintId: textField(),
  outcome: nullable(enumTextField(HINT_OUTCOMES, { label: "Outcome" })),
  seenAt: dateField(),
} satisfies FieldsRecord;

/** The `hint_seen` entity — one row per hint or tour the user has met. */
export const hintSeenEntityRef = entityRef("hint_seen", hintSeenFields);

export const HintSeenSchema = fieldsToZodObject(hintSeenFields);
export type HintSeen = z.infer<typeof HintSeenSchema>;

/**
 * Every seen row, newest first. The set is the declared hints and tours the
 * user has met — dozens, not thousands — so the default window IS the whole
 * table in practice; `maxLimit` bounds it by construction. Preloaded at boot:
 * a tip must never flash while the seen state is in flight, so the read is
 * resident before first paint (`hints/web` still renders nothing while it is
 * pending).
 */
export const hintsSeen = liveCollection("hints.seen", {
  from: hintSeenEntityRef,
  pick: ["outcome"],
  carry: { pick: ["hintId", "seenAt"] },
  id: "hintId",
  sortable: ["seenAt"],
  default: { orderBy: [["seenAt", "desc"]], limit: 250 },
  maxLimit: 500,
  preload: "boot",
});

export const MarkHintSeenBodySchema = z.object({
  id: z.string().min(1),
  outcome: HintOutcomeSchema.nullable(),
});
export type MarkHintSeenBody = z.infer<typeof MarkHintSeenBodySchema>;

/**
 * Marks one hint or tour seen (upsert: the outcome and `seenAt` are
 * overwritten, so a tour marked at its start gets its outcome at its end).
 */
export const markHintSeenEndpoint = defineEndpoint({
  route: "POST /api/hints/seen",
  body: MarkHintSeenBodySchema,
});

export const ResetHintsBodySchema = z.object({
  ids: z.array(z.string().min(1)).max(1000),
});
export type ResetHintsBody = z.infer<typeof ResetHintsBodySchema>;

/**
 * Forgets the seen rows of `ids`. The server knows nothing about kinds: the
 * client sends the ids of the declared tips or tours it wants back.
 */
export const resetHintsEndpoint = defineEndpoint({
  route: "POST /api/hints/reset",
  body: ResetHintsBodySchema,
});
