import {
  defineSourceSet,
  type SourceSet,
} from "@plugins/packages/plugins/source-digest/core";

/**
 * What a corpus index holds, as code: which files belong (`match`) and what
 * each becomes (`parse`). The index is stamped with the digest of the module
 * that declared the format — its `import.meta`, and everything that module
 * loads — so a stored index built by another `match` or `parse` is rebuilt,
 * with no version to remember to bump. A journal catch-up re-checks only the
 * paths that moved, so without that a file the new `match` takes, or the
 * partial the new `parse` reads differently, would stay as the old code left
 * it until a walk.
 *
 * Declare it in a SMALL module (the parse, not the plugin's server entry): the
 * digest moves with everything the module loads, and a move rebuilds the
 * whole index.
 */
export interface CorpusFormat<TPartial> {
  readonly match: (path: string) => boolean;
  readonly parse: (path: string) => Promise<TPartial>;
  /** The declaring module's code — what the stored index is stamped with. */
  readonly code: SourceSet;
}

/**
 * Declare a corpus format in the calling module: `corpusFormat(import.meta,
 * { match, parse })`. Omit `parse` for an enumerate-only corpus (the set of
 * paths, every partial `null`).
 */
export function corpusFormat(
  meta: ImportMeta,
  format: { match: (path: string) => boolean },
): CorpusFormat<null>;
export function corpusFormat<TPartial>(
  meta: ImportMeta,
  format: {
    match: (path: string) => boolean;
    parse: (path: string) => Promise<TPartial>;
  },
): CorpusFormat<TPartial>;
export function corpusFormat<TPartial>(
  meta: ImportMeta,
  format: {
    match: (path: string) => boolean;
    parse?: (path: string) => Promise<TPartial>;
  },
): CorpusFormat<TPartial> {
  const code = defineSourceSet(`the corpus format declared in ${meta.url}`);
  code.include(meta);
  return {
    match: format.match,
    // The ONE place the enumerate-only default is applied (the overload pins
    // `TPartial` to `null` when `parse` is omitted).
    parse: format.parse ?? (() => Promise.resolve(null as TPartial)),
    code,
  };
}
