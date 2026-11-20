import type { SlotMeta } from "@plugins/framework/plugins/slot-declaration/core";

/**
 * The catalog of web lists: every declared web list, and every entry's fact
 * with the plugin it came from — written by the build from the records it
 * keeps of every plugin barrel (codegen's `list-catalog-gen.ts`), for every
 * web plugin of the repo — each composition keeps its own part — in two
 * committed files:
 *
 * - the LISTS (`web-lists/core/web-lists.generated.ts`): each declared web
 *   slot, its declaring plugin, key and `meta` — what a reader of the list SET
 *   needs (the reorderable lists the server registers config for);
 * - the ENTRIES (`server-core/core/web-list-entries.generated.json`): every
 *   entry of every list, as its fact — loaded at boot by the server
 *   (`installWebListEntries`) and shipped to the page per composition.
 *
 * Another composition's catalog is the main one kept to the plugins it loads
 * (an entry's fact is a function of its plugin alone).
 */

/** One declared web list. */
export interface WebListDeclaration {
  /** The list's id (`<declaring plugin>.<key>`). */
  id: string;
  /** The plugin that declares it (dot-form id). */
  plugin: string;
  /** The key it is declared under (its config file's basename). */
  key: string;
  /** What kind of list it is, as the slot stamped it. */
  meta: SlotMeta;
  /**
   * Whether the main composition declares it — the set the server registers
   * a reorder config directive for (`reorder/shared`), as it always was. A
   * list only another composition's plugins declare is in the catalog all
   * the same: its pages read it.
   */
  inMain: boolean;
}

/** One entry of a web list, as the catalog holds it. */
export interface WebListEntry {
  /** The list it belongs to (its id). */
  list: string;
  /** The web plugin that contributed it (dot-form id). */
  plugin: string;
  /** Its fact (`factOf`): plain data, `{ "$code": true }` where a field is code. */
  fact: Readonly<Record<string, unknown>>;
}

/** One plugin providing a companion of a list (its key, for a keyed list). */
export interface CompanionProvider {
  plugin: string;
  key?: string;
}

/** What a page is shipped: its composition's lists and entries. */
export interface WebCatalog {
  lists: readonly WebListDeclaration[];
  entries: readonly WebListEntry[];
  /**
   * For each list of the page opened to companions, EVERY plugin of the repo
   * providing one — not only the page's: a companion the repo provides that
   * the page does not ship is a closure bug the page must name, never a
   * fallback to degrade through (web-sdk's `catalogMismatches`,
   * `useCompanionLookup`).
   */
  companionProviders: Readonly<Record<string, readonly CompanionProvider[]>>;
}

/**
 * The catalog kept to the plugins of one composition: a list declared by one
 * of them, an entry contributed by one of them TO such a list (a plugin that
 * fills its entries from the declared lists — a pane's title item per header
 * slot — added entries to lists this composition does not hold). The
 * companion providers of each kept list stay repo-wide.
 */
export function catalogFor(
  catalog: Omit<WebCatalog, "companionProviders">,
  plugins: ReadonlySet<string>,
): WebCatalog {
  const lists = catalog.lists.filter((l) => plugins.has(l.plugin));
  const kept = new Set(lists.map((l) => l.id));
  const companionProviders: Record<string, CompanionProvider[]> = {};
  for (const l of lists) {
    const option = l.meta.companions;
    if (option === undefined) continue;
    companionProviders[l.id] = catalog.entries
      .filter((e) => e.list === l.id && e.fact.companion === true)
      .map((e) => {
        const key = typeof option === "object" ? e.fact[option.key] : undefined;
        return typeof key === "string"
          ? { plugin: e.plugin, key }
          : { plugin: e.plugin };
      });
  }
  return {
    lists,
    entries: catalog.entries.filter(
      (e) => plugins.has(e.plugin) && kept.has(e.list),
    ),
    companionProviders,
  };
}
