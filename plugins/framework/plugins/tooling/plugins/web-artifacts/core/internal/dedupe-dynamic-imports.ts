// One `import()` per target per chunk.
//
// The registry names every web plugin by its own loader, and the link bundles
// those plugins into a few dozen route chunks — so the boot chunk holds ~1,200
// `import(\`../chunk.<hash>/index.js\`)` calls over only ~100 distinct URLs,
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
  await lexerInit();
  const [imports] = lexerParse(code);
  const sites = new Map<string, Array<{ start: number; end: number }>>();
  for (const imp of imports) {
    if (imp.type !== "dynamic") continue;
    if (imp.specifier === undefined || imp.attributesStart !== -1) continue;
    const list = sites.get(imp.specifier) ?? [];
    list.push({ start: imp.importStart, end: imp.importEnd });
    sites.set(imp.specifier, list);
  }
  const edits: DynamicImportEdit[] = [];
  for (const [specifier, list] of sites) {
    if (list.length < 2) continue;
    const key = JSON.stringify(specifier);
    for (const { start, end } of list) {
      edits.push({
        start,
        end,
        text: `${ONCE}(${key},()=>${code.slice(start, end)})`,
      });
    }
  }
  return edits.sort((a, b) => a.start - b.start);
}
