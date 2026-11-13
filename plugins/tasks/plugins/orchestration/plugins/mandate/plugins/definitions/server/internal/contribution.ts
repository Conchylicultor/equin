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
  /**
   * Set when the mandate is OWNED: a tree under it needs state of the
   * defining plugin beside the mandate id (a role session's root needs the
   * role it works for), so only that plugin's own writes state it. An owned
   * mandate is never stated or unstated by hand (the Mandate select does not
   * offer it, its endpoints refuse) and never copied: a task re-filed out of
   * its tree to the root, which keeps the mandate it had, states `refiledAs`
   * instead — so no task can come to state it without that state.
   */
  owned?: { refiledAs: MandateRef };
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

/**
 * The mandate a task states when it is re-filed to the root from a tree
 * stating `mandateId`: the same one, unless it is owned (see
 * {@link MandateDefinitionEntry.owned}). An id no definition names (an
 * automation since removed) is kept as it is.
 */
export function mandateRefiledAs(mandateId: string): string {
  return (
    mandateDefinitionEntries().get(mandateId)?.owned?.refiledAs.id ?? mandateId
  );
}

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
