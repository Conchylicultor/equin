import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { Contribution, LoadedPlugin } from "./types";
import {
  createPluginRegistry,
  excludingReader,
  NO_CONTRIBUTIONS,
  readerOf,
  scopedReader,
  type PluginRegistry,
  type PluginRegistryReader,
} from "./registry";

// Holds the registry's READ half — one stable object, never a per-append value,
// so a provider re-render or a plugin append never re-renders a reader through
// the context. Not exported: the only read is `useRawContributions(slot)`.
const PluginRegistryContext = createContext<PluginRegistryReader | null>(null);

// The registry a `<PluginScope>` narrows: the enclosing scope's view, or — at
// the page root — the WHOLE registry, on-demand plugins included, which the
// root's own view (`PluginRegistryContext`) leaves out. Null under a provider
// with nothing on demand: a scope then narrows its parent, as it always did.
const PluginScopeBaseContext = createContext<PluginRegistryReader | null>(null);

/**
 * The web plugins a page carries ON DEMAND: listed in its registry beside its
 * own (the web registry's `webScopedEntries` — a bundled browser host's page
 * scope beyond the page's own plugins), loaded only when a `<PluginScope>`
 * over them asks (`useScopePlugins`), and contributing to nothing outside
 * such a scope.
 */
export interface OnDemandPlugins {
  /** Every on-demand plugin id. */
  ids: ReadonlySet<string>;
  /** Whether `id` is loaded (in the registry). */
  isLoaded(id: string): boolean;
  /**
   * Load those of `ids` not loaded yet; resolves once they are in the
   * registry, rejects when one fails to load. Concurrent calls share the
   * loads they have in common.
   */
  load(ids: readonly string[]): Promise<void>;
}

const OnDemandContext = createContext<OnDemandPlugins | null>(null);

// What every `<PluginScope>` mounts inside itself: the page root's element
// rendering the `scope: "each"` root hosts (`PluginProvider`'s `scopeRoots`).
// Null under a provider given none (a test's), where a scope mounts no hosts.
const ScopeRootsContext = createContext<ReactNode>(null);

/** Where loading a scope's on-demand plugins is (`useScopePlugins`). */
export type ScopePluginsState =
  { kind: "pending" } | { kind: "ready" } | { kind: "failed"; error: unknown };

/**
 * Loads the on-demand plugins `composition`'s scope needs, once `enabled`:
 * `ready` at once when it needs none (every plugin is the page's own — main,
 * a test's provider), else `pending` until they are in the registry. A page
 * renders `<PluginScope composition>` only once this is `ready`; the scope
 * throws otherwise. `enabled` is the caller's "start now" (a demo's gate:
 * nothing downloads before the visitor asks).
 */
export function useScopePlugins(
  composition: ScopedComposition,
  enabled: boolean,
): ScopePluginsState {
  const onDemand = useContext(OnDemandContext);
  const missing = useMemo(
    () =>
      onDemand === null
        ? []
        : composition.plugins.filter(
            (id) => onDemand.ids.has(id) && !onDemand.isLoaded(id),
          ),
    [onDemand, composition.plugins],
  );
  // The outcome of loading ONE missing set: a set that changes (another
  // composition) is pending again until its own load settles.
  const [settled, setSettled] = useState<{
    of: readonly string[];
    state: ScopePluginsState;
  } | null>(null);
  useEffect(() => {
    if (!enabled || onDemand === null || missing.length === 0) return;
    let live = true;
    onDemand.load(missing).then(
      () => {
        if (live) setSettled({ of: missing, state: { kind: "ready" } });
      },
      (error: unknown) => {
        if (live) setSettled({ of: missing, state: { kind: "failed", error } });
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, onDemand, missing]);
  if (missing.length === 0) return { kind: "ready" };
  return settled !== null && settled.of === missing
    ? settled.state
    : { kind: "pending" };
}

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
 * The contributions to `slot` that are on the page but that the innermost
 * `<PluginScope>` leaves out, though its composition does not negate their
 * plugin — empty outside every scope. For a framework primitive that falls
 * back when nothing in scope serves a key (`.Dispatch`), to tell "nothing on
 * the page serves this" from "the page serves it, and the scope dropped it":
 * the second is a composition that lost a plugin nobody asked to lose.
 * Subscribed to `slot` only, like {@link useRawContributions}.
 */
export function useScopedOutContributions(
  slot: SlotHandle,
): readonly Contribution[] {
  const reader = useContext(PluginRegistryContext);
  if (!reader) {
    throw new Error("slot contributions must be read within PluginProvider");
  }
  const subscribe = useCallback(
    (listener: () => void) => reader.subscribe(slot, listener),
    [reader, slot],
  );
  const getSnapshot = () => reader.scopedOut(slot);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The composition this page was deployed as — the `composition` export of the
 * web registry it booted from (`@composition-web-registry`), baked in by
 * codegen at build time, so reading it never waits on a request.
 */
export interface CompositionIdentity {
  /** The composition id (the main composition id for the checkout's own app). */
  id: string;
  /**
   * The app owning bare `/` (and the app launcher's click) — a `defineApp` id
   * the composition's manifest declares and `composition-closure` proved is in
   * its bundle; null when the bundle holds no app.
   */
  home: string | null;
  /**
   * The bundled apps its launchers do not offer (`defineApp` ids) — apps the
   * composition holds only because something it asked for imports them.
   * Absent = none.
   */
  unlisted?: readonly string[];
}

const CompositionContext = createContext<CompositionIdentity | null>(null);

/**
 * The deployed composition's identity. Throws outside a `PluginProvider` given
 * one — a surface that needs the homepage must never guess it.
 */
export function useComposition(): CompositionIdentity {
  const composition = useContext(CompositionContext);
  if (!composition) {
    throw new Error(
      "useComposition() needs a PluginProvider given the `composition` its web registry exports",
    );
  }
  return composition;
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
  props: { children: ReactNode } &
    // The boot path always knows what it was deployed as.
    (
      | {
          registry: PluginRegistry;
          composition: CompositionIdentity;
          /**
           * The plugins the registry also holds on demand (`OnDemandPlugins`):
           * left out of every read outside a `<PluginScope>` asking for them.
           * The boot path always passes its own; absent = nothing on demand.
           */
          onDemand?: OnDemandPlugins;
          /**
           * Renders the `scope: "each"` root hosts (`RootScope`) — mounted by
           * every `<PluginScope>` inside itself, so a scope is served by hosts
           * of its own. web-sdk cannot import the root render path
           * (slot-render's), so the page root hands it in. Required on the
           * boot path: a scope without its hosts would be served by the
           * page's, which is the bug this exists to close.
           */
          scopeRoots: ReactNode;
          plugins?: never;
        }
      // Tests and standalone mounts provide one only when what they render reads it.
      | {
          plugins: LoadedPlugin[];
          composition?: CompositionIdentity;
          registry?: never;
          onDemand?: never;
          /** As on the boot path; absent = a scope mounts no root hosts. */
          scopeRoots?: ReactNode;
        }
    ),
) {
  const { children, composition = null } = props;
  const plugins = "plugins" in props ? props.plugins : undefined;
  // Created once: the registry is the ONE object the tree reads for the
  // provider's lifetime.
  const [whole] = useState(() => {
    if (props.registry) return readerOf(props.registry);
    const owned = readerOf(createPluginRegistry());
    owned.replace(plugins ?? []);
    return owned;
  });
  const onDemand = props.onDemand ?? null;
  const scopeRoots = props.scopeRoots ?? null;
  // The page's own view: the whole registry minus what it holds on demand.
  const [reader] = useState(() =>
    onDemand === null || onDemand.ids.size === 0
      ? whole
      : excludingReader(whole, onDemand.ids),
  );
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
      <PluginScopeBaseContext.Provider value={reader === whole ? null : whole}>
        <OnDemandContext.Provider value={onDemand}>
          <ScopeRootsContext.Provider value={scopeRoots}>
            <CompositionContext.Provider value={composition}>
              {children}
            </CompositionContext.Provider>
          </ScopeRootsContext.Provider>
        </OnDemandContext.Provider>
      </PluginScopeBaseContext.Provider>
    </PluginRegistryContext.Provider>
  );
}

// The id of the innermost `PluginScope` (null outside every scope). Not
// exported: the only read is `usePluginScopeId()`.
const PluginScopeIdContext = createContext<string | null>(null);

/**
 * The composition id of the innermost `<PluginScope>` this renders in, or
 * `null` outside every scope — the page's own deploy (and every test or
 * standalone mount). For state a scope must not share with the page around it
 * (`web-storage`'s keys): set by `PluginScope` itself, so a subtree standing
 * for another deploy is scoped by construction, with nothing for a caller to
 * remember.
 */
export function usePluginScopeId(): string | null {
  return useContext(PluginScopeIdContext);
}

/**
 * A composition a subtree is scoped to: its identity plus the web plugins its
 * bundle ships — generated by the codegen that resolved the bundle, never
 * hand-listed (a hand subset would drop a companion some in-set owner needs,
 * and `useCompanionLookup` would throw).
 */
export type ScopedComposition = CompositionIdentity & {
  plugins: readonly string[];
  /**
   * The web plugins the composition excludes by name (its negatives' direct
   * targets) — left out on purpose, so a fallback for one of them is no
   * surprise (`useScopedOutContributions` skips them). Absent = none.
   */
  negated?: readonly string[];
};

/**
 * Renders `children` as if the page had been deployed as `composition`: every
 * slot read inside sees only the contributions of `composition.plugins` (except
 * `pageWide` slots), `useComposition()` answers `composition`'s id, home and
 * unlisted apps, and
 * `usePluginScopeId()` answers its id (what scopes the subtree's browser
 * storage).
 *
 * For a subtree that stands for ANOTHER deploy inside this page — the demo's
 * embedded app, served by a host that boots only that composition's plugins —
 * so the page renders exactly what that host serves, by construction.
 *
 * It mounts the `scope: "each"` root hosts inside itself (`RootScope`), ahead
 * of `children`, so the scope is served by hosts of its own — reading its
 * contributions, its transport and its id — never by the page's.
 *
 * Limits: the global `register` phase (module writes applied once per page) is
 * not scopable; and the first read of a slot from inside a scope records the
 * scope's contributors in its `slot-read:` timing mark.
 */
export function PluginScope({
  composition,
  children,
}: {
  composition: ScopedComposition;
  children: ReactNode;
}) {
  const view = useContext(PluginRegistryContext);
  const base = useContext(PluginScopeBaseContext);
  const onDemand = useContext(OnDemandContext);
  const scopeRoots = useContext(ScopeRootsContext);
  if (!view) {
    throw new Error("PluginScope must be rendered within PluginProvider");
  }
  // What the scope narrows: the whole registry at the page root (its
  // on-demand plugins are the scope's to show), else the enclosing scope.
  const parent = base ?? view;
  const { id, home, unlisted, plugins, negated } = composition;
  const unloaded =
    onDemand === null
      ? []
      : plugins.filter((p) => onDemand.ids.has(p) && !onDemand.isLoaded(p));
  if (unloaded.length > 0) {
    throw new Error(
      `PluginScope "${id}": ${unloaded.length} of its plugins are on demand and not loaded (${unloaded.slice(0, 3).join(", ")}${unloaded.length > 3 ? ", …" : ""}) — render it once useScopePlugins(composition) is ready.`,
    );
  }
  // Left out on purpose, never "scoped out": the composition's negatives,
  // and — narrowing the whole registry at the root — every on-demand plugin
  // another scope loaded that this one does not hold.
  const reader = useMemo(() => {
    const held = new Set(plugins);
    const leftOut = new Set(negated);
    if (base !== null && onDemand !== null) {
      for (const p of onDemand.ids) if (!held.has(p)) leftOut.add(p);
    }
    return scopedReader(parent, held, leftOut);
  }, [parent, base, onDemand, plugins, negated]);
  const identity = useMemo(
    () => (unlisted === undefined ? { id, home } : { id, home, unlisted }),
    [id, home, unlisted],
  );
  return (
    <PluginRegistryContext.Provider value={reader}>
      {/* A nested scope narrows this one. */}
      <PluginScopeBaseContext.Provider value={null}>
        <CompositionContext.Provider value={identity}>
          <PluginScopeIdContext.Provider value={id}>
            {scopeRoots}
            {children}
          </PluginScopeIdContext.Provider>
        </CompositionContext.Provider>
      </PluginScopeBaseContext.Provider>
    </PluginRegistryContext.Provider>
  );
}
