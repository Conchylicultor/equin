// Which sourcemaps an artifact carries — the one answer both the builder (which
// asserts it right after a build) and the vendored-module scan (which reads
// every map's `sources`) use.
//
// Every emitted module that holds code has a `<file>.map`. The one module that
// legitimately has none is a pure re-export facade: Rolldown emits a
// multi-entry artifact's `index.js` as `import {…} from "./web-….mjs"; export
// {…};` when every module it reaches is shared with a co-entry, and a facade
// maps no source, so it gets no map. Anything else without a map is a build
// whose inlined modules no scan could see — loud, never skipped.

import {
  init as esLexerInit,
  parse as esLexerParse,
} from "es-module-lexer/minimal";

/**
 * True when `code` is nothing but static imports / re-exports and `export {…}`
 * lists — a module that maps no source of its own.
 */
export function isReexportFacade(code: string, name: string): boolean {
  const [imports] = esLexerParse(code, name);
  let rest = "";
  let at = 0;
  for (const imp of imports) {
    if (imp.d !== -1) return false; // a dynamic import is code
    rest += code.slice(at, imp.ss);
    at = imp.se;
  }
  rest += code.slice(at);
  return /^(?:\s|;|export\s*\{[^}]*\})*$/.test(rest);
}

/**
 * The sourcemap files among an artifact dir's top-level `files` (`index.js`,
 * co-entries, `.mjs` chunks), sorted. Throws when a module that is not a
 * re-export facade has no map. Worker bundles (`WORKER_ASSETS_DIR`) are a
 * separate realm and are not listed. `read` returns a listed file's text.
 */
export async function artifactSourcemaps(opts: {
  label: string;
  files: readonly string[];
  read: (name: string) => string;
}): Promise<string[]> {
  await esLexerInit();
  const present = new Set(opts.files);
  const maps: string[] = [];
  for (const name of [...opts.files].sort()) {
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
    const map = `${name}.map`;
    if (present.has(map)) {
      maps.push(map);
      continue;
    }
    if (!isReexportFacade(opts.read(name), name)) {
      throw new Error(
        `artifact ${opts.label}: ${name} has no ${map} and is not a pure re-export facade — ` +
          `its inlined modules cannot be verified (every artifact builds with sourcemap: true)`,
      );
    }
  }
  if (maps.length === 0) {
    throw new Error(
      `artifact ${opts.label} has no sourcemap at all — cannot verify inlined modules`,
    );
  }
  return maps;
}
