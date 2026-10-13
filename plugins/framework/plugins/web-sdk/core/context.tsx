import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution, LoadedPlugin } from "./types";
import {
  createPluginRegistry,
  NO_CONTRIBUTIONS,
  readerOf,
  type PluginRegistry,
  type PluginRegistryReader,
} from "./registry";

// Holds the registry's READ half — one stable object, never a per-append value,
// so a provider re-render or a plugin append never re-renders a reader through
// the context. Not exported: the only read is `useRawContributions(slot)`.
const PluginRegistryContext = createContext<PluginRegistryReader | null>(null);

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
 * The one way to read a slot's contributions from the registry. Every reader
 * (`useContributions`, `.Render`, `.Mount`, `.Dispatch`, presence checks)
 * funnels here, so "which slots did this screen read" has exactly one answer.
 */
function contributionsOf(
  reader: PluginRegistryReader,
  slot: SlotHandle,
): readonly Contribution[] {
  const list = reader.read(slot);
  // A slot whose declaring plugin has not loaded yet (a deferred owner) has
  // no id; it is recorded on its first read after the declaration lands.
  if (!readSlots.has(slot) && slot._pluginId !== undefined) {
    readSlots.add(slot);
    const detail: SlotReadDetail = {
      owner: slot._pluginId,
      contributors: [...new Set(list.map((c) => String(c._pluginId)))],
    };
    performance.mark(`${SLOT_READ_TIMING_PREFIX}${slot.id}`, { detail });
  }
  return list;
}

const noopUnsubscribe = () => {};

/**
 * A slot's stamped (`_pluginId`, unsealed) contributions, in topo order —
 * subscribed to THAT slot only, so the component re-renders when this slot's
 * list changes and never because some other slot's did. The array identity is
 * stable while the list is unchanged.
 *
 * `slot` may be `undefined` (an optional slot a hook cannot branch on): the
 * answer is then the empty list. Prefer `slot.useContributions()` (sealed) or
 * the slot-render constructors; this raw read is for framework primitives that
 * need the stamp or an unsealed payload.
 */
export function useRawContributions(
  slot: SlotHandle | undefined,
): readonly Contribution[] {
  const reader = useContext(PluginRegistryContext);
  if (!reader) {
    throw new Error("slot contributions must be read within PluginProvider");
  }
  const subscribe = useCallback(
    (listener: () => void) =>
      slot ? reader.subscribe(slot, listener) : noopUnsubscribe,
    [reader, slot],
  );
  const getSnapshot = () =>
    slot ? contributionsOf(reader, slot) : NO_CONTRIBUTIONS;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Provides the plugin registry to the tree. Two forms:
 *
 * - `registry` — the boot path: `App` creates the registry once and appends
 *   each loaded batch to it directly, so neither `App` nor this provider
 *   re-renders per batch; only the readers of changed slots do.
 * - `plugins` — a fixed (or occasionally swapped) list, for tests and
 *   standalone mounts: the provider owns a registry and re-derives it when the
 *   prop's identity changes.
 */
export function PluginProvider(
  props: { children: ReactNode } & (
    | { registry: PluginRegistry; plugins?: never }
    | { plugins: LoadedPlugin[]; registry?: never }
  ),
) {
  const { children } = props;
  const plugins = "plugins" in props ? props.plugins : undefined;
  // Created once: the registry is the ONE object the tree reads for the
  // provider's lifetime.
  const [reader] = useState(() => {
    if (props.registry) return readerOf(props.registry);
    const owned = readerOf(createPluginRegistry());
    owned.replace(plugins ?? []);
    return owned;
  });
  const applied = useRef(plugins);
  // A swapped `plugins` prop is applied after render (a registry write
  // notifies other components, which must not happen during this render); its
  // readers re-render synchronously, before paint.
  useLayoutEffect(() => {
    if (plugins === undefined || plugins === applied.current) return;
    applied.current = plugins;
    reader.replace(plugins);
  }, [reader, plugins]);

  return (
    <PluginRegistryContext.Provider value={reader}>
      {children}
    </PluginRegistryContext.Provider>
  );
}
