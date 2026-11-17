// One `import()` per target per chunk.
//
// The registry names every web plugin by its own loader, and the link bundles
// those plugins into a few dozen route chunks — so the boot chunk holds ~1,200
// `import("@chunk/<id>")` calls over only ~100 distinct chunks,
// and the eager tier runs ~1,000 of them at once. A browser does not answer a
// repeated `import()` of a module it already has for free: each call runs the
// module-tree fetch again — every static descendant looked up in the module
// map, one posted task per lookup. Measured on the eager tier (Chromium,
// 2026-11-15): ~180,000 tasks on the main thread, most of the `load-plugins`
// span; 1,000 re-imports of one loaded chunk ~0.45 s, one import of it ~0.1 s.
//
// So within a chunk, every target imported from more than one place goes
// through one memo: the first call imports it, every later call gets the same
// promise. A rejected import is forgotten, so a retry (the deferred tier's
// Reload) imports again — the rejection itself still reaches every caller.
// The `import(<literal>)` stays written out as the memo's loader, so every
// lexer-based reader of a chunk (staged-verify, the meta's dynamic imports)
// still sees the edge.

import { init as lexerInit, parse as lexerParse } from "es-module-lexer";

/** The memo's name in a chunk: no rolldown-emitted identifier starts `__equin`. */
const ONCE = "__equinImportOnce";

/** Prepended to a chunk with a repeated dynamic import (module scope, hoisted). */
export const IMPORT_ONCE_HELPER =
  `const ${ONCE}$cache=new Map();` +
  `function ${ONCE}(key,load){let p=${ONCE}$cache.get(key);` +
  `if(p===undefined){p=load();${ONCE}$cache.set(key,p);` +
  `p.then(undefined,()=>{${ONCE}$cache.delete(key)})}return p}\n`;

/** How every edit routing an import through the memo starts. */
export const IMPORT_ONCE_CALL = `${ONCE}(`;

export interface DynamicImportEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * The edits that route each repeated literal dynamic import of `code` through
 * {@link IMPORT_ONCE_HELPER}: `import(X)` → `__equinImportOnce(X,()=>import(X))`.
 * Empty when no target is imported twice (the chunk is left untouched). An
 * import with attributes, or of a computed specifier, is never touched.
 */
export async function dedupeDynamicImportEdits(
  code: string,
): Promise<DynamicImportEdit[]> {
  return rewriteImportEdits(code, (spec) => spec);
}

/**
 * The edits that respell every import specifier of `code` as `rename` maps it
 * (`rename(s) === s` leaves it as written) and route each repeated literal
 * dynamic import through {@link IMPORT_ONCE_HELPER}, keyed by its new
 * spelling — one pass, so no two edits overlap. A computed or attributed
 * dynamic import is neither renamed nor deduplicated.
 */
export async function rewriteImportEdits(
  code: string,
  rename: (specifier: string) => string,
): Promise<DynamicImportEdit[]> {
  await lexerInit();
  const [imports] = lexerParse(code);
  const edits: DynamicImportEdit[] = [];
  const sites = new Map<
    string,
    Array<{ start: number; end: number; s: number; e: number }>
  >();
  for (const imp of imports) {
    if (imp.type === "import-meta" || imp.specifier === undefined) continue;
    if (imp.type === "dynamic") {
      if (imp.attributesStart !== -1) continue;
      const list = sites.get(imp.specifier) ?? [];
      list.push({
        start: imp.importStart,
        end: imp.importEnd,
        s: imp.start,
        e: imp.end,
      });
      sites.set(imp.specifier, list);
      continue;
    }
    // A static import's range is the specifier without its quotes.
    const renamed = rename(imp.specifier);
    if (renamed !== imp.specifier)
      edits.push({ start: imp.start, end: imp.end, text: renamed });
  }
  for (const [specifier, list] of sites) {
    const renamed = rename(specifier);
    // A dynamic import's specifier range includes its quotes.
    const literal = JSON.stringify(renamed);
    for (const { start, end, s, e } of list) {
      if (list.length < 2) {
        if (renamed !== specifier)
          edits.push({ start: s, end: e, text: literal });
        continue;
      }
      const call =
        renamed === specifier
          ? code.slice(start, end)
          : code.slice(start, s) + literal + code.slice(e, end);
      edits.push({ start, end, text: `${ONCE}(${literal},()=>${call})` });
    }
  }
  return edits.sort((a, b) => a.start - b.start);
}
