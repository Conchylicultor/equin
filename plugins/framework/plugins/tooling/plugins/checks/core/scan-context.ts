import { AsyncLocalStorage } from "node:async_hooks";
import type { FileSystemView } from "./read-set";
import type { GrepIndex } from "./grep-index";

// Ambient scan context for a single check.run(). Carries:
//   - `tree`: the git tree-ish the cache key (treeHash) was computed from, so any
//     source scanner (grepCode) inspects EXACTLY the content the cache key
//     represents — closing the gap where computeTreeHash includes untracked
//     files (via `add -A`) but a working-tree `git grep` does not, which let a
//     PASS be recorded for content never scanned.
//   - `view`: the recording FileSystemView for an input-keyed check (null for a
//     legacy whole-tree-keyed check, which sets no read-set). When present, the
//     check's reads route through it so its read-set is captured. This is a LIVE
//     path, not a dormant one: nine checks set `inputKeyed` today (`type-check`,
//     `plugin-boundaries`, and the seven grepCode pattern checks), so recording
//     fires on every check pass.
//   - `grep`: the run's grep index over `tree` (`grep-index.ts`), or null when
//     the run has no tree or no index store — candidate selection then runs
//     `git grep` itself.
const store = new AsyncLocalStorage<{
  tree: string | null;
  view: FileSystemView | null;
  grep: GrepIndex | null;
}>();

/**
 * Run `fn` with `tree` as the ambient scan target and `view` as the ambient
 * recording view. `tree === null` → no target (run scans the working tree,
 * uncached). `view === null` → legacy path, nothing recorded.
 */
export function withScanView<T>(
  tree: string | null,
  view: FileSystemView | null,
  grep: GrepIndex | null,
  fn: () => Promise<T>,
): Promise<T> {
  return tree === null && view === null
    ? fn()
    : store.run({ tree, view, grep }, fn);
}

/** The tree-ish the current check should scan, or null to fall back to the working tree. */
export function currentScanTree(): string | null {
  const s = store.getStore();
  return s?.view?.tree ?? s?.tree ?? null;
}

/** The recording view for the current check, or null when not input-keyed. */
export function currentScanView(): FileSystemView | null {
  return store.getStore()?.view ?? null;
}

/**
 * The run's grep index, when the current check scans the run's own tree; null
 * otherwise (no index, or a recording view over a tree the index is not over).
 */
export function currentGrepIndex(): GrepIndex | null {
  const s = store.getStore();
  if (!s?.grep) return null;
  return (s.view?.tree ?? s.tree) === s.tree ? s.grep : null;
}
