import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { SlotNaming } from "@plugins/framework/plugins/slot-declaration/core";
import { reorderDirectiveDescriptor } from "../../shared/directive";

/**
 * The ONE descriptor instance per reorderable slot for the web runtime, derived
 * from the slots themselves — `meta.reorderable` says which slots owe one, and
 * the declaration says who owns each.
 *
 * NOTHING here reads the list catalog's generated declared lists. That is not
 * a preference: the manifest is now derived from the declarations by importing
 * web barrels, so a web barrel that imported it at module-load would freeze the
 * PREVIOUS run's copy in the codegen process (Bun's ESM cache) and no later
 * write could refresh it. The server keeps reading it — it cannot see web slots,
 * and its barrels are imported after the manifest is written.
 *
 * `useConfig`/`useSetConfig` match a config registration by descriptor
 * *reference identity* (`reg.descriptor === descriptor`), so the descriptor
 * passed to `ConfigV2.WebRegister` and the one the middleware looks up MUST be
 * the same object. `descriptorFor` is memoized per slot id and never replaces an
 * entry, which is what guarantees that across repeated declaration passes.
 */
const descriptorBySlot = new Map<string, ConfigDescriptor>();
const ownerBySlot = new Map<string, PluginId>();

// Memoized by slot id (globally unique) while the descriptor is NAMED by the
// declaration key — the config file's basename, under the owning plugin's
// directory. Two plugins may key a slot `sidebar`; their descriptors are still
// distinct objects because the memo key is the full id.
function descriptorFor(slotId: string, configName: string): ConfigDescriptor {
  let descriptor = descriptorBySlot.get(slotId);
  if (!descriptor) {
    descriptor = reorderDirectiveDescriptor(configName);
    descriptorBySlot.set(slotId, descriptor);
  }
  return descriptor;
}

/** Descriptor lookup for the middleware and the data-level read hook. */
export const reorderDescriptors: ReadonlyMap<string, ConfigDescriptor> =
  descriptorBySlot;

export interface ReorderDescriptorEntry {
  slotId: string;
  descriptor: ConfigDescriptor;
  pluginId: PluginId;
}

/**
 * All [slotId, descriptor, owner] triples, for registration in the web barrel.
 *
 * A STABLE array object rewritten in place by {@link syncReorderDescriptors} —
 * the plugin registry re-reads each plugin's `contributions` on every pass, so the
 * set grows as deferred plugins arrive, while the array identity every consumer
 * holds never changes.
 */
export const reorderDescriptorEntries: ReorderDescriptorEntry[] = [];

/**
 * Re-derive the reorderable-slot set from one declaration pass: every slot THAT
 * PASS declared whose `meta.reorderable` is true, sorted by slot id — the same
 * derivation, in the same order, as the build's reorderable-slot manifest
 * (`codegen/core/reorderable-slots-gen.ts`).
 *
 * Read off the pass's own naming, never off the process's created-slot set and
 * its `_pluginId` / `_key` stamps. The created set is in MODULE-EVALUATION
 * order, and the stamps are the union of every pass that ever ran in this
 * process — both a function of what else this process imported or declared,
 * not of the declared set. The build evaluates the reorder barrel in a process
 * that already loaded other closures, a fresh check does not, so the stored
 * record listed these registrations in a different order than a fresh
 * evaluation (plugin-records.verify: a slot keyed `block` stored where a fresh
 * evaluation had one keyed `item`). Sorted by id, the list is a function of the
 * declared set alone — the set its declared record is keyed by.
 */
export function syncReorderDescriptors(naming: SlotNaming): void {
  reorderDescriptorEntries.length = 0;
  const entries = naming
    .declarations()
    .filter((entry) => entry.slot.meta.reorderable)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { id, pluginId, key } of entries) {
    ownerBySlot.set(id, pluginId);
    reorderDescriptorEntries.push({
      slotId: id,
      descriptor: descriptorFor(id, key),
      pluginId,
    });
  }
}

/**
 * The defining plugin's dot-form id for a reorderable slot — read off the owner
 * the declaration pass stamped, so it can neither depend on module-cache order
 * nor drift from where the slot's config file lands. `""` for an unknown slot
 * (never thrown — callers only ask about known reorderable slots).
 */
export function reorderPluginIdForSlot(slotId: string): string {
  return ownerBySlot.get(slotId) ?? "";
}
