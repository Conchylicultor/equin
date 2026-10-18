import { useCallback } from "react";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { companionManifest } from "./companions.generated";
import { readerOf, type PluginRegistry } from "./registry";
import { useDeferredLoadComplete } from "./deferred-load-store";

/**
 * A companion the repo provides is not in the running bundle.
 *
 * The closure engine ships a companion wherever its owner ships (keyed: wherever
 * its key is used), so this is a closure bug, a stale registry or a plugin that
 * failed to load — never a state to degrade through. Without it the owner falls
 * back quietly: blank icons, slots in registration order, a DataView cell drawn
 * as text.
 */
export class MissingCompanionError extends Error {
  override name = "MissingCompanionError";
}

/**
 * Every `companions: true` slot the loaded plugins declare whose repo-wide
 * companions (`companions.generated.ts`) did not all contribute, as messages.
 * Meaningful once the deferred tier has settled — before that a companion may
 * simply not have loaded yet. A slot opened to companions that the manifest does
 * not list is reported too: the manifest is stale, so this guard would be blind.
 *
 * Keyed slots are not judged here: whether one of their companions is needed
 * depends on what the page uses, so {@link useCompanionLookup} judges them at
 * the lookup that misses.
 */
export function missingCompanions(registry: PluginRegistry): string[] {
  const reader = readerOf(registry);
  const problems: string[] = [];
  for (const { slot, id, pluginId } of reader.declared()) {
    if (!slot.meta.companions) continue;
    const entry = companionManifest[id];
    if (!entry) {
      problems.push(
        `slot "${id}" (${pluginId}) is opened to companions, but companions.generated.ts does not list it — run \`./singularity build\``,
      );
      continue;
    }
    if (!("always" in entry)) continue;
    const present = new Set(reader.read(slot).map((c) => String(c._pluginId)));
    for (const plugin of entry.always)
      if (!present.has(plugin))
        problems.push(
          `${pluginId} needs its companion ${plugin} (slot "${id}"), which this bundle does not ship`,
        );
  }
  return problems;
}

/**
 * The lookup of a KEYED companion slot (`companions: { key, space }`) along a
 * chain of keys — a field type and the types it extends — returning the first
 * contribution serving one of them, or `undefined` when none does.
 *
 * A key with no provider anywhere in the repo is passed over: its absence is
 * the design (a type without its own cell draws its ancestor's). A key the repo
 * DOES provide but this bundle lacks throws {@link MissingCompanionError} once
 * the deferred tier has settled — from render, so the nearest error boundary
 * shows it in place. Before that it resolves to `undefined` without walking on,
 * and the reader re-renders when the tier settles.
 */
export function useCompanionLookup<C extends object>(
  slot: SlotHandle,
  list: readonly C[],
): (keys: readonly string[]) => C | undefined {
  const settled = useDeferredLoadComplete();
  return useCallback(
    (keys) => {
      const option = slot.meta.companions;
      if (typeof option !== "object")
        throw new Error(
          `useCompanionLookup: slot "${slot.id}" is not a keyed companion slot (\`companions: { key, space }\`)`,
        );
      // A slot no loaded plugin declares has no owner here, so nothing in this
      // registry expects its companions (a test rendering a view on its own).
      const entry =
        slot._pluginId === undefined ? undefined : companionManifest[slot.id];
      const provided = entry && "keyed" in entry ? entry.keyed : undefined;
      for (const key of keys) {
        const hit = list.find(
          (c) => (c as Record<string, unknown>)[option.key] === key,
        );
        if (hit) return hit;
        const providers = provided?.[key];
        if (!providers) continue;
        if (!settled) return undefined;
        throw new MissingCompanionError(
          `${slot.id}: ${option.space} "${key}" is served by ${providers.join(", ")}, which this bundle does not ship`,
        );
      }
      return undefined;
    },
    [slot, list, settled],
  );
}
