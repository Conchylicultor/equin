// plugin-boundaries' input-keyed read-set (Stage 3 of the input-keyed check
// cache — see research/2026-07-17-global-input-keyed-check-cache.md).
//
// plugin-boundaries is one of the most expensive checks: it covers the ENTIRE
// plugins/ source tree (buildPluginTree + the git-derived enumeration in
// ./source-files and ./repo-tree), reads every .ts/.tsx file, parses its
// imports, and evaluates them against the boundary rules — plus reads every package.json (R1 naming + the compositionRoot marker)
// and every runtime barrel, and derives the standard-dir set from every
// core/*.ts. Its OUTER cache was whole-tree keyed, so ANY byte change anywhere
// re-ran the whole walk, and every push-rebase was a guaranteed miss.
//
// This module records, into the ambient recording FileSystemView, EVERY
// filesystem fact the verdict depends on, so validate-by-replay turns a change
// touching none of them into a HIT. It records a SOUND SUPERSET as pure snapshot
// projections (no byte reads, no extra git calls), rather than threading the view
// through buildPluginTree / standardPluginDirsIn (which read the fs directly —
// Stage 3 of the plan would do that; a superset here is strictly sound today).
// The superset can only ever OVER-invalidate (an unnecessary re-run), never
// UNDER-invalidate (which would be the catastrophic stale PASS).
//
// SOUNDNESS — the check-LOGIC surface (sourceHash). A grepless membership+content
// read-set is only sound if the check's OWN logic is also pinned: buildPluginTree
// (the plugin-set + compositionRoot detector) lives in
// plugins/plugin-meta/plugins/plugin-tree/, which `CHECK_SOURCE_PREFIXES`
// (read-set.ts) was widened to cover — else a change to the plugin-position walk
// or the compositionRoot marker could flip the verdict with no recorded tree-fact
// change. Everything else the check calls (standardPluginDirsIn / discoverCollected-
// DirsIn in codegen/, runtimeNames in boundaries/, findImports/maskSource in
// parse-utils/) is already under a covered prefix.

import type { FileSystemView } from "@plugins/framework/plugins/tooling/plugins/checks/core";

/**
 * Record plugin-boundaries' complete read-set into `view` (a no-op caller-side
 * when the view is null — the legacy whole-tree path). Two fact kinds:
 *
 *  (a) MEMBERSHIP of the whole plugins/ file set — the H3/H9 fact. EVERYTHING
 *      the check reads lives under plugins/ (both source roots, buildPluginTree
 *      over `plugins/`, standardPluginDirsIn → discoverCollectedDirsIn over
 *      `plugins/`). Any ADDED / REMOVED / RENAMED path under plugins/ changes
 *      this match set → MISS: a new .ts with a violating import, a new plugin dir
 *      (even one holding only a non-.ts file — buildPluginTree's content gate
 *      makes it a plugin, adding an R1 "missing package.json" violation), a
 *      new/removed barrel or package.json. A content-only read-set records only
 *      files that ALREADY exist, so it can never see a NEW file — this membership
 *      fact is exactly what makes a newly-added violating file FAIL instead of
 *      stale-PASS. `plugins/**` expands (superset-safe) to every blob under
 *      plugins/ in the snapshot, which includes untracked-not-ignored files (the
 *      tree is `git add -A`-seeded), so a brand-new uncommitted file is seen.
 *
 *  (b) CONTENT of every file whose BYTES the verdict reads: the .ts/.tsx sources
 *      the walk parses (R4–R10 import grammar, R3 barrel purity, the cross-plugin
 *      re-export provenance chase, discoverCollectedDirsIn's `defineCollectedDir`
 *      scan of core/*.ts) AND every package.json (R1 naming + the compositionRoot
 *      marker buildPluginTree reads). A change to any of them can flip the verdict
 *      → each is a FileFact → any edit is a MISS. Non-source files
 *      (.md/.sql/.css/…) never affect the verdict — only their EXISTENCE does,
 *      already covered by (a) — so they get no content fact (recording their bytes
 *      would only over-invalidate). recordFile takes the blobSha from the snapshot
 *      the view wraps — no byte read, no re-hash.
 */
export function recordBoundaryReadSet(view: FileSystemView): void {
  const all = view.glob("plugins/**");
  for (const path of all) {
    if (
      path.endsWith(".ts") ||
      path.endsWith(".tsx") ||
      path.endsWith("/package.json")
    ) {
      view.recordFile(path);
    }
  }
}
