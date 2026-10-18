import { z } from "zod";
import { resolvableSchema } from "@plugins/primitives/plugins/live-state/core";

// Where an attempt's branch stands relative to `main`, as measured from git.
// Every arm is a MEASURED fact — the unmeasurable case is the `Resolvable`
// unresolved arm of the payload below, exactly as `edited-files` does it.
export const AttemptPendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("measured"),
    ahead: z.number().int().nonnegative(), // commits main does not contain
    behind: z.number().int().nonnegative(),
    branch: z.string().nullable(),
    mergeBase: z.string().nullable(),
  }),
  // The branch ref no longer exists, so no unpushed commit of this attempt can
  // survive to be lost. A DETERMINATE answer — a failed git read THROWS instead.
  z.object({ kind: z.literal("no-branch") }),
]);
export type AttemptPending = z.infer<typeof AttemptPendingSchema>;

export const AttemptWorkSchema = z.object({
  pending: AttemptPendingSchema,
  /** This attempt's commits `main` already contains, found by their
   *  Singularity-Conversation trailers. Git-measured; cannot lag. */
  landedCommits: z.number().int().nonnegative(),
  /** Distinct Singularity-Push trailer values among them — the true push count. */
  landedPushes: z.number().int().nonnegative(),
  /** Corroborating ledger evidence (I3). A row PROVES a push; its absence proves
   *  nothing. Only ORed into "landed", never used to conclude "nothing landed" —
   *  this is what keeps pre-trailer-era attempts from reading as droppable. */
  ledgerPushes: z.number().int().nonnegative(),
  /** A scratch attempt recorded its delivery — the landed fact of a workspace
   *  with no git (no branch, no trailers). Always false for a git workspace,
   *  which lands by pushing. */
  delivered: z.boolean(),
});
export type AttemptWork = z.infer<typeof AttemptWorkSchema>;

// Wire payload: the measured standing, or a determinate "nobody could measure
// this" non-value (`{resolved: false, reason}`). See
// research/2026-07-09-global-resource-unknown-value-and-error-gate.md.
export const AttemptWorkPayloadSchema = resolvableSchema(AttemptWorkSchema);
export type AttemptWorkPayload = z.infer<typeof AttemptWorkPayloadSchema>;
