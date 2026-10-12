import { createRefcountHub } from "@plugins/packages/plugins/refcount-hub/core";
import type { SourceImpl } from "./contribution";

// What makes a source's numbers stale is the source's own `changes` (a change
// feed, a git ref, a refresh job), and every served query and drill-down page
// of the source must hear it. One `changes` subscription per source, however
// many tuples watch it (the refcount hub): the first `acquire` starts it, each
// change fans out to every acquirer's `notify`, and the last release stops it
// — so nothing watches a source no tab reads.

export interface SourceWatch {
  /**
   * Hear `sourceId`'s changes until the returned release runs. A source with
   * no `changes` never changes on its own: nothing is watched, and the release
   * is a no-op.
   */
  acquire(sourceId: string, notify: () => void): () => void;
}

/** A hub over the sources `sourceOf` resolves (it throws on an unknown id). */
export function createSourceWatch(
  sourceOf: (sourceId: string) => SourceImpl,
): SourceWatch {
  const hub = createRefcountHub<void>((sourceId, emit) => {
    const { changes } = sourceOf(sourceId);
    // `acquire` below never opens a source without `changes`.
    if (changes === undefined)
      throw new Error(`source ${sourceId} has no changes`);
    return changes(() => emit());
  });
  return {
    acquire(sourceId, notify) {
      if (sourceOf(sourceId).changes === undefined) return () => {};
      return hub.acquire(sourceId, () => notify()).release;
    },
  };
}
