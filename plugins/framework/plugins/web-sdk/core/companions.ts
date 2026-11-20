import { useCallback } from "react";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { usePageCatalog } from "./catalog";
import { useDeferredLoadComplete } from "./deferred-load-store";

/**
 * A companion the page's list catalog says this page holds is not loaded.
 *
 * The closure engine ships a companion wherever its owner ships (keyed: wherever
 * its key is used), and the catalog is the build's facts of exactly what this
 * composition's plugins add to each list, so this is a closure bug, a stale
 * registry or a plugin that failed to load — never a state to degrade through.
 * Without it the owner falls back quietly: blank icons, a DataView cell drawn
 * as text.
 */
export class MissingCompanionError extends Error {
  override name = "MissingCompanionError";
}

/**
 * The lookup of a KEYED companion slot (`companions: { key, space }`) along a
 * chain of keys — a field type and the types it extends — returning the first
 * contribution serving one of them, or `undefined` when none does.
 *
 * Which keys have a provider is read from the list catalog's companion
 * providers — repo-wide, not only this page's: a key no plugin provides is
 * passed over — its absence is the design (a type without its own cell draws
 * its ancestor's). A key some plugin provides but the loaded plugins do not throws
 * {@link MissingCompanionError} once the deferred tier has settled — from
 * render, so the nearest error boundary shows it in place. Before that it
 * resolves to `undefined` without walking on, and the reader re-renders when
 * the tier settles. Under a provider given no catalog (a test's), every key is
 * looked up in the loaded list alone.
 */
export function useCompanionLookup<C extends object>(
  slot: SlotHandle,
  list: readonly C[],
): (keys: readonly string[]) => C | undefined {
  const settled = useDeferredLoadComplete();
  const catalog = usePageCatalog();
  return useCallback(
    (keys) => {
      const option = slot.meta.companions;
      if (typeof option !== "object")
        throw new Error(
          `useCompanionLookup: slot "${slot.id}" is not a keyed companion slot (\`companions: { key, space }\`)`,
        );
      // A slot no loaded plugin declares has no id here, so nothing in this
      // registry expects its companions (a test rendering a view on its own).
      const provided =
        catalog === null || slot._pluginId === undefined
          ? []
          : (catalog.companionProviders[slot.id] ?? []);
      for (const key of keys) {
        const hit = list.find(
          (c) => (c as Record<string, unknown>)[option.key] === key,
        );
        if (hit) return hit;
        const providers = provided
          .filter((p) => p.key === key)
          .map((p) => p.plugin);
        if (providers.length === 0) continue;
        if (!settled) return undefined;
        throw new MissingCompanionError(
          `${slot.id}: ${option.space} "${key}" is served by ${providers.join(", ")}, which this page has not loaded`,
        );
      }
      return undefined;
    },
    [slot, list, settled, catalog],
  );
}
