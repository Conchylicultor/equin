import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import type { MandateRef } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * Every named mandate the code defines (`Mandate.Definition`): its id, label
 * and the mandates it is a kind of (`mandateKinds`: itself, then what it
 * extends) — the options of the `mandate` field every task list shows, and
 * what {@link mandateIsKindOf} reads. Fixed for the process (contributions
 * register at boot), hydrated before first paint.
 */
export const MandateDefinitionsSchema = wholeList(
  z.object({
    id: z.string(),
    label: z.string(),
    kinds: wholeList(z.string(), {
      reason: "one mandate's lineage: itself and what it extends, a few",
    }),
  }),
  {
    reason:
      "one entry per named mandate the code defines — the presets and one per automation, a handful",
  },
);
export type MandateDefinitions = z.infer<typeof MandateDefinitionsSchema>;

export const mandateDefinitions = liveValue("mandate.definitions", {
  schema: MandateDefinitionsSchema,
  preload: "boot-and-keep",
});

/**
 * Whether the mandate stored as `mandateId` is `base` or a kind of it
 * (extends it, however deep) — read from the served definitions, so a mandate
 * built on `base` later answers yes with no change at the asker. An id no
 * plugin defines throws, as resolving it does.
 */
export function mandateIsKindOf(
  definitions: MandateDefinitions,
  mandateId: string,
  base: MandateRef,
): boolean {
  const entry = definitions.find((d) => d.id === mandateId);
  if (entry === undefined) {
    throw new Error(
      `Mandate "${mandateId}" is stored on a task but no plugin defines it (MandateDefinitions)`,
    );
  }
  return entry.kinds.includes(base.id);
}

/** Every defined mandate that is `base` or a kind of it, by id. */
export function mandatesOfKind(
  definitions: MandateDefinitions,
  base: MandateRef,
): string[] {
  return definitions.filter((d) => d.kinds.includes(base.id)).map((d) => d.id);
}
