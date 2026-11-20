import { createContext, useContext } from "react";
import {
  factJson,
  type WebCatalog,
  type WebListEntry,
} from "@plugins/framework/plugins/list-catalog/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { readerOf, type PluginRegistry } from "./registry";

/**
 * The list catalog a page was shipped (`@composition-web-catalog`, kept to its
 * composition by the build): every web list its plugins declare and every
 * entry's FACT with the plugin it came from — complete before any plugin has
 * loaded. Indexed once per provider.
 */
export interface PageCatalog {
  /** Each declared list's id → its declaration. */
  readonly lists: ReadonlyMap<string, WebCatalog["lists"][number]>;
  /** Each list's id → its entries, in catalog order. */
  readonly entries: ReadonlyMap<string, readonly WebListEntry[]>;
  /** Each companion list's id → every plugin of the REPO providing one. */
  readonly companionProviders: WebCatalog["companionProviders"];
}

export function indexCatalog(catalog: WebCatalog): PageCatalog {
  const entries = new Map<string, WebListEntry[]>();
  for (const e of catalog.entries) {
    let list = entries.get(e.list);
    if (list === undefined) entries.set(e.list, (list = []));
    list.push(e);
  }
  return {
    lists: new Map(catalog.lists.map((l) => [l.id, l])),
    entries,
    companionProviders: catalog.companionProviders,
  };
}

/** Null under a provider given no catalog (a test's, a standalone mount). */
export const CatalogContext = createContext<PageCatalog | null>(null);

/** The page's catalog, or null when the provider was given none. */
export function usePageCatalog(): PageCatalog | null {
  return useContext(CatalogContext);
}

const NO_ENTRIES: readonly WebListEntry[] = Object.freeze([]);

/** The catalog's entries of `slot` (none for a list it does not hold). */
export function catalogEntriesOf(
  catalog: PageCatalog,
  slot: SlotHandle,
): readonly WebListEntry[] {
  return catalog.entries.get(slot.id) ?? NO_ENTRIES;
}

/**
 * Where the loaded plugins and the catalog the page was shipped disagree — as
 * messages, once the deferred tier has settled (before that a plugin may
 * simply not have loaded yet). The runtime half of "an entry that cannot be
 * written as data fails the build": what the build saw of each plugin must be
 * what the page's plugins declare.
 *
 * - a list the loaded plugins declare that the catalog does not hold, while
 *   the catalog keeps no list out (`meta.catalog`): the catalog is stale;
 * - a list whose entries from a LOADED plugin differ from the catalog's —
 *   in number or in fact (an entry computed from something only known at
 *   run time, a stale catalog);
 * - an entry of a plugin the page holds (`isPagePlugin`) that never loaded:
 *   the closure, the registry or the load lost it. This is what a companion
 *   the bundle lacks looks like, so it subsumes the companion check (the
 *   owner degrading silently: blank icons, a cell drawn as text).
 *
 * `step` is awaited between lists, so the page's main thread is never held
 * for the whole catalog.
 */
export async function catalogMismatches(
  registry: PluginRegistry,
  shipped: WebCatalog,
  isPagePlugin: (pluginId: string) => boolean,
  step: () => Promise<void>,
): Promise<string[]> {
  const reader = readerOf(registry);
  const catalog = indexCatalog(shipped);
  const problems: string[] = [];
  const declared = reader.declared();
  // Every plugin the page loaded that contributes anywhere, first: an entry
  // missing from one list is "never loaded" only for a plugin seen nowhere.
  const loaded = new Set<string>();
  for (const { slot, id, pluginId } of declared) {
    loaded.add(pluginId);
    for (const c of reader.read(slot)) loaded.add(String(c._pluginId));
    if (slot.meta.catalog !== undefined) continue;
    if (!catalog.lists.has(id)) {
      problems.push(
        `list "${id}" (${pluginId}) is declared by a loaded plugin but is not in the page's list catalog — the catalog is stale; run \`./equin build\``,
      );
    }
  }
  for (const { slot, id } of declared) {
    if (slot.meta.catalog !== undefined) continue;
    const live = new Map<string, string[]>();
    for (const c of reader.read(slot)) {
      const plugin = String(c._pluginId);
      let list = live.get(plugin);
      if (list === undefined) live.set(plugin, (list = []));
      list.push(factJson(c, `"${id}" entry of ${plugin}`));
    }
    const written = new Map<string, string[]>();
    for (const e of catalogEntriesOf(catalog, slot)) {
      let list = written.get(e.plugin);
      if (list === undefined) written.set(e.plugin, (list = []));
      list.push(JSON.stringify(e.fact));
    }
    for (const [plugin, facts] of written) {
      const have = live.get(plugin) ?? [];
      if (have.length === 0 && !loaded.has(plugin)) {
        if (isPagePlugin(plugin))
          problems.push(
            `${plugin} adds ${facts.length} entr${facts.length === 1 ? "y" : "ies"} to "${id}" in the page's list catalog, but this page never loaded it`,
          );
        continue;
      }
      if (have.join("\n") !== facts.join("\n")) {
        problems.push(
          `"${id}" entries of ${plugin} differ from the page's list catalog (${have.length} declared, ${facts.length} in the catalog) — an entry computed from something only known at run time cannot be a catalog fact, or the catalog is stale`,
        );
      }
    }
    // An always-shipped companion the repo provides that this page never
    // loaded (a page plugin or not: the closure ships every companion with
    // its owner, so one missing here is a closure bug or a failed load).
    if (slot.meta.companions === true) {
      for (const { plugin } of catalog.companionProviders[id] ?? []) {
        if (!loaded.has(plugin) && !written.has(plugin))
          problems.push(
            `${slot._pluginId ?? id} needs its companion ${plugin} (list "${id}"), which this page does not ship`,
          );
      }
    }
    for (const [plugin, facts] of live) {
      if (!written.has(plugin))
        problems.push(
          `${plugin} declares ${facts.length} entr${facts.length === 1 ? "y" : "ies"} of "${id}" that the page's list catalog does not hold — the catalog is stale`,
        );
    }
    await step();
  }
  return problems;
}
