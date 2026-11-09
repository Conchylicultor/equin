import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";

export interface SymbolEntry {
  readonly name: SavedSymbolName;
  /** The name as words (`smart toy`), for the tooltip and search. */
  readonly label: string;
}
export interface SymbolCategory {
  readonly label: string;
  readonly entries: readonly SymbolEntry[];
}
export interface SymbolSet {
  readonly categories: readonly SymbolCategory[];
  readonly count: number;
  search(query: string): SymbolEntry[];
}

let cached: Promise<SymbolSet> | null = null;

/**
 * The picker's data — every Material Symbols name Google's metadata lists that
 * the installed sets draw, by category, with its search tags. Loaded on first
 * call (~1 MB of JSON, its own chunk), then kept. The glyphs are not in it:
 * each cell draws through `<Icon>`'s runtime symbols, so only visible rows load.
 */
export function loadSymbolSet(): Promise<SymbolSet> {
  cached ??= import("./symbols-metadata.json").then(({ default: meta }) => {
    type Rich = SymbolEntry & { haystack: string };
    const categories = meta.categories.map((label) => ({
      label,
      entries: [] as Rich[],
    }));
    const all: Rich[] = [];
    for (const [name, category, tags] of meta.icons as [
      string,
      number,
      string,
    ][]) {
      // Google's list and the installed sets move independently: a name
      // Google lists that the installed sets do not draw (yet) is not offered.
      if (!isSavedSymbolName(name)) continue;
      const label = name.replace(/-/g, " ");
      const entry: Rich = { name, label, haystack: `${name} ${label} ${tags}` };
      const bucket = categories[category];
      if (!bucket) {
        throw new Error(`[icon-picker] "${name}" has no category ${category}`);
      }
      bucket.entries.push(entry);
      all.push(entry);
    }
    return {
      categories,
      count: all.length,
      search(query: string): SymbolEntry[] {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const hits = all.filter((e) =>
          words.every((w) => e.haystack.includes(w)),
        );
        // Names that say the query come before names only tagged with it.
        const named = (e: Rich) => words.every((w) => e.label.includes(w));
        return [...hits.filter(named), ...hits.filter((e) => !named(e))];
      },
    };
  });
  // A failed load is not kept: the next picker to mount tries again.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
