/**
 * A set of modules whose CODE some persisted or inherited state depends on —
 * the parse that filled an index, the compiler that shaped a handed-over
 * value. Its digest (`sourceDigest`, the server barrel) is a hash of every
 * module the set's modules statically load, so the state can be stamped with
 * the code that produced it and refused under any other: a version nobody
 * has to remember to bump.
 *
 * `include` takes a module's `import.meta` itself, not a path or a URL: a
 * module can only hand over its own, so "the module this code lives in" has no
 * wrong spelling.
 *
 * Plain data on purpose (no platform API): a set is declared by portable code
 * — a compiler that also runs in a browser host — and digested only where the
 * source is on disk.
 */
export interface SourceSet {
  /** What the set's code produces, in words (an error names it). */
  readonly description: string;
  /** Add the calling module (`import.meta`) — and with it everything it loads. */
  include(meta: ImportMeta): void;
  /** The included modules' URLs, sorted. */
  urls(): readonly string[];
}

// Every set ever defined, so a host can digest them all as early as it boots
// (`prewarmSourceDigests`): a digest describes the files when it READS them, so
// the closer to when their modules were imported, the better.
const sets: SourceSet[] = [];

export function defineSourceSet(description: string): SourceSet {
  const urls = new Set<string>();
  const set: SourceSet = {
    description,
    include(meta) {
      urls.add(meta.url);
    },
    urls: () => [...urls].sort(),
  };
  sets.push(set);
  return set;
}

/** Every set defined so far, in definition order. */
export function allSourceSets(): readonly SourceSet[] {
  return sets;
}
