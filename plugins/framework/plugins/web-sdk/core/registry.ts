import { topoSortPlugins } from "@plugins/framework/plugins/plugin-loader/core";
import { declarePluginSlots } from "@plugins/framework/plugins/slot-declaration/core";
import type {
  SlotHandle,
  SlotNamingEntry,
} from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution, LoadedPlugin } from "./types";

/**
 * The loaded plugin set, as ONE object for the lifetime of the page (or of a
 * `PluginProvider`). Loading more plugins mutates it; it is never replaced.
 *
 * The only thing a reader can do with it is read ONE slot (`useRawContributions`,
 * `slot.useContributions()`, the slot-render constructors). There is no "all
 * contributions" or "all plugins" view, so a component that re-renders whenever
 * ANY plugin arrives has no spelling: appending a batch notifies exactly the
 * readers of the slots whose contribution list changed.
 */
export interface PluginRegistry {
  /**
   * Add a freshly-loaded batch: runs its register phase and a declaration pass
   * over the grown set, then re-derives every slot's list and notifies the
   * readers of the slots whose list changed. Called OUTSIDE render.
   */
  append(plugins: readonly LoadedPlugin[]): void;
}

/** The per-slot read half — reachable only through the context, i.e. a hook. */
export interface PluginRegistryReader {
  read(slot: SlotHandle): readonly Contribution[];
  subscribe(slot: SlotHandle, listener: () => void): () => void;
  /** Replace the whole plugin set (`PluginProvider`'s `plugins` prop). */
  replace(plugins: readonly LoadedPlugin[]): void;
  /** Every slot the loaded plugins declare, as the last declaration pass named them. */
  declared(): readonly SlotNamingEntry[];
}

/** Shared "no contributions" list, so an empty slot's snapshot is stable. */
export const NO_CONTRIBUTIONS: readonly Contribution[] = Object.freeze([]);

// Tracks plugins whose `register` array has been applied, so a second registry
// (a remounted PluginProvider) or a re-derivation never double-invokes
// registry writes.
const registered = new WeakSet<LoadedPlugin>();

function runRegisterPhase(plugins: LoadedPlugin[]): LoadedPlugin[] {
  const ordered = topoSortPlugins(plugins);
  for (const p of ordered) {
    if (registered.has(p)) continue;
    registered.add(p);
    for (const r of p.register ?? []) {
      try {
        const result = r.register();
        // Web register is contractually sync; if a Promise sneaks through
        // (mistyped helper), surface the rejection rather than letting it
        // dangle silently.
        if (result instanceof Promise) {
          // eslint-disable-next-line promise-safety/no-bare-catch
          result.catch((err) =>
            console.error(`[plugin.${p.id}] register failed`, err),
          );
        }
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch (err) {
        console.error(`[plugin.${p.id}] register failed`, err);
      }
    }
  }
  return ordered;
}

function sameElements(
  a: readonly Contribution[],
  b: readonly Contribution[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// The read half of every registry, keyed by its public handle — so `append` is
// all `createPluginRegistry`'s caller holds, and reading takes the context.
const readers = new WeakMap<PluginRegistry, PluginRegistryReader>();

/** The read half of a registry; throws for an object no factory minted. */
export function readerOf(registry: PluginRegistry): PluginRegistryReader {
  const reader = readers.get(registry);
  if (!reader) {
    throw new Error(
      "[plugins] not a plugin registry — create one with createPluginRegistry()",
    );
  }
  return reader;
}

export function createPluginRegistry(): PluginRegistry {
  let plugins: readonly LoadedPlugin[] = [];
  let bySlot = new Map<SlotHandle, readonly Contribution[]>();
  let declared: readonly SlotNamingEntry[] = [];
  const listeners = new Map<SlotHandle, Set<() => void>>();
  // Each contribution is stamped ONCE per plugin, so its identity survives
  // every later append — which is what lets an unchanged slot keep its array.
  const stamps = new WeakMap<
    LoadedPlugin,
    WeakMap<Contribution, Contribution>
  >();

  function stamp(p: LoadedPlugin, c: Contribution): Contribution {
    let byRaw = stamps.get(p);
    if (!byRaw) {
      byRaw = new WeakMap();
      stamps.set(p, byRaw);
    }
    let stamped = byRaw.get(c);
    if (!stamped) {
      stamped = { ...c, _pluginId: p.id, _pluginDescription: p.description };
      byRaw.set(c, stamped);
    }
    return stamped;
  }

  function replace(next: readonly LoadedPlugin[]): void {
    plugins = next;
    const ordered = runRegisterPhase([...next]);
    // The slot pass, sibling of the `_pluginId` contribution stamp: each
    // declared slot gets its declaring plugin stamped onto the slot OBJECT (not
    // a copy — the reorder middleware looks descriptors up by reference), and
    // two plugins claiming one slot throws. Ownership therefore comes off the
    // declaration rather than off module-cache order.
    //
    // NOT a completeness check: web plugins load in tiers, so mid-boot both the
    // created and the declared sets are partial. `created \ declared` is gated
    // at build time, in the codegen process, which imports every barrel.
    // `"registry"`: `ordered` IS the registry — the plugin set this browser
    // loaded — so a slot this pass does not name is one no loaded plugin
    // declares, not one some disabled plugin owns off-screen.
    declared = declarePluginSlots(ordered, "registry").declarations();

    // Every slot is re-derived, not only the batch's: a plugin's contributions
    // array may be rewritten by the declaration pass above (reorder's per-slot
    // config registrations), and a late plugin can land mid-way through a
    // slot's topo order. A list equal element-wise to the previous one keeps
    // the previous ARRAY, so its readers see no change.
    const fresh = new Map<SlotHandle, Contribution[]>();
    for (const p of ordered) {
      for (const c of p.contributions ?? []) {
        let list = fresh.get(c._slot);
        if (!list) {
          list = [];
          fresh.set(c._slot, list);
        }
        list.push(stamp(p, c));
      }
    }
    const nextBySlot = new Map<SlotHandle, readonly Contribution[]>();
    const changed: SlotHandle[] = [];
    for (const [slot, list] of fresh) {
      const prev = bySlot.get(slot);
      if (prev && sameElements(prev, list)) {
        nextBySlot.set(slot, prev);
      } else {
        nextBySlot.set(slot, Object.freeze(list));
        changed.push(slot);
      }
    }
    for (const slot of bySlot.keys()) {
      if (!fresh.has(slot)) changed.push(slot);
    }
    bySlot = nextBySlot;
    // Notify after the whole map is settled, so a listener reading a second
    // slot never sees a half-applied batch.
    for (const slot of changed) {
      const ls = listeners.get(slot);
      if (ls) for (const l of [...ls]) l();
    }
  }

  const registry: PluginRegistry = {
    append(batch) {
      replace([...plugins, ...batch]);
    },
  };
  readers.set(registry, {
    read: (slot) => bySlot.get(slot) ?? NO_CONTRIBUTIONS,
    subscribe(slot, listener) {
      let ls = listeners.get(slot);
      if (!ls) {
        ls = new Set();
        listeners.set(slot, ls);
      }
      ls.add(listener);
      return () => {
        ls.delete(listener);
      };
    },
    replace,
    declared: () => declared,
  });
  return registry;
}
