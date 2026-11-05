import type { BlockDeleteHook } from "@plugins/page/plugins/editor/server";

// HARD delete / purge: the FK cascade wipes a deleted subtree's `page_links`
// edges, and the L4 change-feed recomputes every subscribed `pageBacklinks`
// tuple. No hand-snapshot / re-push needed.
//
// There is no TRASH or RESTORE hook, on purpose: an edge is derived from its
// SOURCE page's content alone, so trashing either end writes no edge. Every
// reader filters liveness instead — a trashed source by the live join
// (`liveBlocks`, `pageLinkTargets`' base), a trashed target by the nested
// `pageLive` rollup — so a restore brings every edge back at once, with no
// reindex.
export const backlinksDeleteHook: BlockDeleteHook = {
  onDelete: () => undefined,
};
