import { createContext, useMemo, type ReactNode } from "react";
import { topoSortPlugins } from "@plugins/framework/plugins/plugin-loader/core";
import { declarePluginSlots } from "@plugins/framework/plugins/slot-declaration/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution, LoadedPlugin } from "./types";

export interface PluginRuntime {
  plugins: LoadedPlugin[];
  contributions: Contribution[];
  /**
   * Keyed by the slot OBJECT. A contribution names its slot by identity (see
   * `Contribution._slot`), so this map never needs an id — which is what lets a
   * slot's id be derived from its declaring plugin rather than captured when the
   * contribution was minted.
   */
  bySlot: Map<SlotHandle, Contribution[]>;
}

export const PluginRuntimeContext = createContext<PluginRuntime | null>(null);

/**
 * Prefix of the per-slot first-read User Timing marks: `slot-read:<slot id>`,
 * one per slot, stamped the first time anything in this page reads it. Readers
 * outside the bundle (the cold-start benchmark) learn which slots a screen
 * needed — the set a load-on-first-read plugin loader would have to load.
 */
export const SLOT_READ_TIMING_PREFIX = "slot-read:";

/** The `detail` a slot's first-read mark carries. */
export interface SlotReadDetail {
  /** The id of the plugin that declares the slot. */
  owner: string;
  /** The ids of the plugins contributing to it at that first read. */
  contributors: string[];
}

const readSlots = new WeakSet<SlotHandle>();

/**
 * The one way to read a slot's contributions from the runtime. Every reader
 * (`useContributions`, `.Render`, `.Mount`, `.Dispatch`, presence checks)
 * funnels here, so "which slots did this screen read" has exactly one answer.
 */
export function contributionsOf(
  runtime: PluginRuntime,
  slot: SlotHandle,
): Contribution[] | undefined {
  // A slot whose declaring plugin has not loaded yet (a deferred owner) has
  // no id; it is recorded on its first read after the declaration lands.
  if (!readSlots.has(slot) && slot._pluginId !== undefined) {
    readSlots.add(slot);
    const detail: SlotReadDetail = {
      owner: slot._pluginId,
      contributors: [
        ...new Set(
          (runtime.bySlot.get(slot) ?? []).map((c) => String(c._pluginId)),
        ),
      ],
    };
    performance.mark(`${SLOT_READ_TIMING_PREFIX}${slot.id}`, { detail });
  }
  return runtime.bySlot.get(slot);
}

// Tracks plugins whose `register` array has been applied so a remount of
// PluginProvider (or a useMemo recompute) doesn't double-invoke registry
// writes.
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

export function PluginProvider({
  plugins,
  children,
}: {
  plugins: LoadedPlugin[];
  children: ReactNode;
}) {
  const runtime = useMemo(() => {
    const ordered = runRegisterPhase(plugins);
    // The slot pass, sibling of the `_pluginId` contribution stamp below: each
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
    declarePluginSlots(ordered, "registry");
    const contributions = ordered.flatMap((p) =>
      (p.contributions ?? []).map((c) => ({
        ...c,
        _pluginId: p.id,
        _pluginDescription: p.description,
      })),
    );
    const bySlot = new Map<SlotHandle, Contribution[]>();
    for (const c of contributions) {
      let list = bySlot.get(c._slot);
      if (!list) {
        list = [];
        bySlot.set(c._slot, list);
      }
      list.push(c);
    }
    return { plugins, contributions, bySlot };
  }, [plugins]);

  return (
    <PluginRuntimeContext.Provider value={runtime}>
      {children}
    </PluginRuntimeContext.Provider>
  );
}
