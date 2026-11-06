import {
  defineSourceSet,
  type SourceSet,
} from "@plugins/packages/plugins/source-digest/core";

/**
 * How an append-only, newline-delimited file becomes its partial, as a fold
 * over its lines. A format declared this way is read from where the index last
 * stopped: an append costs the appended bytes, not the whole file (a
 * transcript is re-read on every line its agent writes — whole, that was
 * O(file) per line, O(n²) over a conversation).
 *
 * - `start` — a fresh state for `path`, before its first line.
 * - `line` — fold one complete line (its newline stripped, never empty) into
 *   `state`, in place.
 * - `partial` — what `state` stands for now, as a SNAPSHOT: the state keeps
 *   folding after it, so the partial must share nothing mutable with it.
 *
 * Only newline-terminated lines are folded: a trailing line with no newline
 * yet is being written, and is read once its newline lands.
 */
export interface LineFold<TState, TPartial> {
  readonly start: (path: string) => TState;
  readonly line: (state: TState, line: string) => void;
  readonly partial: (state: TState) => TPartial;
}

/**
 * How the index reads one file: whole (`parse`, re-run on every change) or as
 * a line fold continued from where it stopped (`lines`).
 */
export type CorpusRead<TPartial> =
  | {
      readonly kind: "file";
      readonly parse: (path: string) => Promise<TPartial>;
    }
  // The fold's state type is the index's business only: erased here so a
  // format is one type whatever its state (see `corpusFormat`).
  | { readonly kind: "lines"; readonly fold: LineFold<unknown, TPartial> };

/**
 * What a corpus index holds, as code: which files belong (`match`) and what
 * each becomes (`read`). The index is stamped with the digest of the module
 * that declared the format — its `import.meta`, and everything that module
 * loads — so a stored index built by another `match` or reading is rebuilt,
 * with no version to remember to bump. A journal catch-up re-checks only the
 * paths that moved, so without that a file the new `match` takes, or the
 * partial the new reading reads differently, would stay as the old code left
 * it until a walk.
 *
 * Declare it in a SMALL module (the parse, not the plugin's server entry): the
 * digest moves with everything the module loads, and a move rebuilds the
 * whole index.
 */
export interface CorpusFormat<TPartial> {
  readonly match: (path: string) => boolean;
  readonly read: CorpusRead<TPartial>;
  /** The declaring module's code — what the stored index is stamped with. */
  readonly code: SourceSet;
}

/**
 * Declare a corpus format in the calling module: `corpusFormat(import.meta,
 * { match, parse })` for a file read whole, `{ match, lines }` for an
 * append-only line file read from where it stopped ({@link LineFold}). Omit
 * both for an enumerate-only corpus (the set of paths, every partial `null`).
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
export function corpusFormat<TState, TPartial>(
  meta: ImportMeta,
  format: {
    match: (path: string) => boolean;
    lines: LineFold<TState, TPartial>;
  },
): CorpusFormat<TPartial>;
export function corpusFormat<TState, TPartial>(
  meta: ImportMeta,
  format: {
    match: (path: string) => boolean;
    parse?: (path: string) => Promise<TPartial>;
    lines?: LineFold<TState, TPartial>;
  },
): CorpusFormat<TPartial> {
  const code = defineSourceSet(`the corpus format declared in ${meta.url}`);
  code.include(meta);
  const read: CorpusRead<TPartial> = format.lines
    ? // The one place the fold's state type is erased: the index only ever
      // hands a state back to the fold that started it.
      { kind: "lines", fold: format.lines as LineFold<unknown, TPartial> }
    : {
        kind: "file",
        // The ONE place the enumerate-only default is applied (the overload
        // pins `TPartial` to `null` when `parse` is omitted).
        parse: format.parse ?? (() => Promise.resolve(null as TPartial)),
      };
  return { match: format.match, read, code };
}
