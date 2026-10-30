import { z } from "zod";

/** A named mandate's stable id — what a task stores (`tasks.mandate_ref`). */
export const MandateIdSchema = z.string().min(1).brand<"MandateId">();
export type MandateId = z.infer<typeof MandateIdSchema>;

/**
 * A named mandate: what a task points at, never a copy of its grants. The
 * grants are the `Mandate.Definition` contributed for it (server), computed
 * each time they are read — so a capability added to a definition reaches
 * every tree under it, running ones included. Minted only by
 * {@link defineMandate}, so a write site cannot invent an id.
 */
export interface MandateRef {
  readonly id: MandateId;
  /** What a person reads in a list's Mandate field. */
  readonly label: string;
}

export function defineMandate(def: { id: string; label: string }): MandateRef {
  return Object.freeze({ id: MandateIdSchema.parse(def.id), label: def.label });
}
