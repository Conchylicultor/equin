import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import type {
  SlotHandle,
  SlotRecord,
} from "@plugins/framework/plugins/slot-declaration/core";

/**
 * Auto-documentable metadata attached to contributions and registration tokens.
 * The `kind` is never stored here — it is always derived from structural
 * identity (`_slot` for slot contributions, `_kind` for registrations).
 */
export interface DocMeta {
  /** Human-readable label for this specific contribution. */
  label?: string;
  /** Optional extra detail (description excerpt, path, etc.). */
  detail?: string;
}

export type Contribution = {
  /**
   * The slot this contribution targets — the SLOT OBJECT, not its id.
   *
   * A contribution is minted when a barrel's `contributions: [...]` array
   * literal evaluates, which is at MODULE EVAL — before any declaration pass has
   * run, and (for `App.tsx`'s boot-task and app-prefix reads) before
   * `PluginProvider` exists at all. A slot's id is derived from its declaring
   * plugin, so at that moment there is no id to capture. The object, on the other
   * hand, is already itself.
   *
   * Dispatch therefore keys on identity, and the id string is left to be what it
   * actually is: a persistence and documentation key, read later.
   */
  _slot: SlotHandle;
  /**
   * Injected by PluginProvider from the enclosing plugin's `id` — the
   * dotted plugin id (e.g. `conversations.conversation-view`).
   */
  _pluginId?: PluginId;
  _pluginDescription?: string;
  _doc?: DocMeta;
  [key: string]: unknown;
};

/**
 * A lazy registry write. Returned by helpers like `Mcp.tool`, `Runtime.define`,
 * `defineJob`, `defineTriggerEvent`, and `UNSAFE_installDurableHooks`. The
 * framework walks `plugin.register: Registration[]` during the register phase
 * and invokes `.register()` on each token in topo-sorted order.
 *
 * Dual-purpose factories (`defineJob`, `defineTriggerEvent`'s `event` field)
 * implement Registration alongside their public API on the same object —
 * `const dispatchJob = defineJob({...})` exposes `.enqueue` (factory role)
 * and `.register()` (framework hook).
 */
export interface Registration {
  register(): void | Promise<void>;
  /** Auto-set by the factory (e.g. "mcp-tool", "job"). Never manually specified. */
  readonly _kind?: string;
  _doc?: DocMeta;
}

/**
 * Authored plugin shape — exactly what a barrel default-exports. `id` is
 * deliberately absent: it is NOT hand-authored. The loader derives it from the
 * plugin's unique directory/hierarchy path (see {@link LoadedPlugin}), which
 * makes duplicate ids impossible by construction. There is also no human
 * `name`: a plugin is identified solely by its derived id, and the short label
 * any UI needs is the id's leaf segment. User-facing titles belong to the
 * contributions a plugin makes (an app's tooltip, a sidebar entry's label),
 * not to the plugin package itself.
 */
export interface PluginDefinition {
  description: string;
  /**
   * Marks the plugin as critical core infrastructure. Load-bearing plugins
   * appear with full detail in `docs/plugins-compact.md` (always-loaded by
   * agents); other plugins appear only as a name + one-liner.
   */
  loadBearing?: boolean;
  /**
   * Fold this TOP-LEVEL plugin's sub-tree into one `[N sub-plugins]` entry in
   * `docs/plugins-compact.md`. A nested plugin's sub-tree is folded by default
   * (the flag there is refused); it opts out with `expanded: true`.
   */
  collapsed?: boolean;
  /** List this NESTED plugin's sub-plugins in `docs/plugins-compact.md` (see `collapsed`). */
  expanded?: boolean;
  contributions?: Contribution[];
  /**
   * The slots this plugin OWNS, keyed by the name each one gets — the exact
   * sibling of `contributions`, and the only thing that makes a slot
   * discoverable, attributable AND named.
   *
   * A slot has no id of its own: its id is `${pluginId}.${key}`, so the key here
   * is where the name comes into existence and the plugin prefix is why it can
   * never disagree with its owner. A value is a slot, or an object whose own
   * values are slots — so a slot group needs no keys of its own, while a pane
   * gets one:
   *
   * ```ts
   * slots: Studio,                             // → apps.studio.shell.sidebar, .toolbar
   * slots: { canvas: canvasPane },             // → …graph.canvas.actions
   * slots: { ...Studio, detail: detailPane },
   * ```
   *
   * Values are read ONE level deep. That shortcut cannot degrade into a blind
   * spot: every slot ever constructed is recorded at construction, and the
   * build-time guard fails naming any that no plugin declared — so a slot nested
   * deeper is reported, not lost. Two plugins declaring one slot is an error, and
   * so is one plugin's two slots landing on one key.
   */
  slots?: SlotRecord;
  /**
   * Plugins this plugin's `register` array must run after. Mirror of the
   * server field with the same name; rarely needed on web because
   * contributions are pure declarative data.
   */
  dependsOn?: PluginDefinition[];
  /**
   * Lazy registry-write tokens applied by `PluginProvider` on mount, before
   * any `Core.Root` contribution renders. Sequential, topo-sorted. Sync-only
   * on web (the React mount path is synchronous). Most web plugins do not
   * need this — contributions are declarative data.
   */
  register?: Registration[];
}

/**
 * A plugin as it exists at runtime: the authored shape plus the loader-injected
 * identity. `id` is the plugin's dotted plugin id (e.g.
 * `conversations.conversation-view.jsonl-viewer`), guaranteed unique because
 * directory paths cannot collide. All framework readers (topo sort,
 * register/contribution tagging) operate on this type, so `p.id` is always a
 * defined string with no optionality. `dependsOn` is narrowed to other loaded
 * plugins (it is resolved by the loader, never hand-authored).
 */
export type LoadedPlugin = Omit<PluginDefinition, "dependsOn"> & {
  id: PluginId;
  dependsOn?: LoadedPlugin[];
};
