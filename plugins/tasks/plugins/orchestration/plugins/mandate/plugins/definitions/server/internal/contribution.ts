import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import {
  mandateKinds,
  type MandatePolicy,
  type MandateRef,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/policy/core";

/**
 * What a named mandate grants: contributed by the plugin that defines it (the
 * presets, each automation). `policy` runs at EVERY resolution, so a change to
 * it — a capability added, an automation's settings changed — reaches every
 * tree under the mandate at once.
 */
export interface MandateDefinitionEntry {
  mandate: MandateRef;
  policy: () => MandatePolicy;
}

const DefinitionToken = defineServerContribution<MandateDefinitionEntry>(
  "mandateDefinition",
  { docLabel: (d) => d.mandate.id },
);

/**
 * A family of definitions the contributor only knows at runtime — one per
 * automation registered — read at each lookup, so its members need no
 * contribution each.
 */
export interface MandateDefinitionSourceEntry {
  id: string;
  definitions: () => readonly MandateDefinitionEntry[];
}

const DefinitionSourceToken =
  defineServerContribution<MandateDefinitionSourceEntry>(
    "mandateDefinitionSource",
    { docLabel: (s) => s.id },
  );

/**
 * - `MandateDefinitions.Definition({ mandate, policy })` — what a named
 *   mandate grants;
 * - `MandateDefinitions.Source({ id, definitions })` — a runtime family of
 *   them.
 */
export const MandateDefinitions = {
  Definition: DefinitionToken,
  Source: DefinitionSourceToken,
};

/** Every defined mandate, by id; a second definition of an id throws. */
export function mandateDefinitionEntries(): Map<
  string,
  MandateDefinitionEntry
> {
  const byId = new Map<string, MandateDefinitionEntry>();
  const all = [
    ...DefinitionToken.getContributions(),
    ...DefinitionSourceToken.getContributions().flatMap((s) => [
      ...s.definitions(),
    ]),
  ];
  for (const entry of all) {
    if (byId.has(entry.mandate.id)) {
      throw new Error(`Mandate "${entry.mandate.id}" is defined twice`);
    }
    byId.set(entry.mandate.id, entry);
  }
  return byId;
}

/**
 * Whether the mandate stored as `mandateId` is `base` or a kind of it
 * (extends it, however deep — `MandateRef.extends`), so a mandate built on
 * `base` later answers yes with no change at the asker. An id no plugin
 * defines throws, as resolving it does.
 */
export function mandateIsKindOf(mandateId: string, base: MandateRef): boolean {
  const entry = mandateDefinitionEntries().get(mandateId);
  if (entry === undefined) {
    throw new Error(
      `Mandate "${mandateId}" is stored on a task but no plugin defines it (MandateDefinitions)`,
    );
  }
  return mandateKinds(entry.mandate).includes(base.id);
}
