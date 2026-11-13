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
  /**
   * The mandate this one is a kind of — built on its grants, adding its own —
   * or `null`. What makes "is this tree a <kind>?" one question over the
   * lineage ({@link mandateKinds}) rather than a list of ids every asker
   * keeps in step.
   */
  readonly extends: MandateRef | null;
}

export function defineMandate(def: {
  id: string;
  label: string;
  /** The mandate this one is a kind of ({@link MandateRef.extends}). */
  extends?: MandateRef;
}): MandateRef {
  return Object.freeze({
    id: MandateIdSchema.parse(def.id),
    label: def.label,
    extends: def.extends ?? null,
  });
}

/**
 * Every mandate `mandate` is a kind of: itself first, then each one it
 * extends, nearest first. `isKindOf(base)` is `kinds.includes(base.id)`.
 */
export function mandateKinds(mandate: MandateRef): readonly MandateId[] {
  const kinds: MandateId[] = [];
  for (let m: MandateRef | null = mandate; m !== null; m = m.extends) {
    kinds.push(m.id);
  }
  return kinds;
}
