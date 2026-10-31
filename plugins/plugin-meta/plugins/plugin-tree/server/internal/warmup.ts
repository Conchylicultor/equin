import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  getFacetsTreeCached,
  getStructureTreeCached,
} from "./structure-tree-cache";

// Host-scoped boot warm-up for the two in-memory plugin-tree caches. The full
// facets build is seconds of pure CPU (every plugin × every facet extractor) and
// both memos die with the process, so on main — which restarts on every deploy —
// the first Studio/plugin-view request of each process paid the whole build
// synchronously (the first `composition.data` / `plugin-view.facets-tree` live
// read; formerly slow-op GET /api/composition/data, 5–42s per cold hit).
// Pre-building here moves that cost off the interactive path into the drain's
// throttled post-boot window. `host` scope: worktree backends skip it — their
// Studio surfaces are rarely opened, and N×-worktree boots would multiply a 5s
// CPU burn exactly when the host is busiest. They keep the lazy cold path.
//
// No declared budget: it is judged on the default warm-up bar, which the build
// overruns today (~4–5 s of thread CPU, 2026-10-31: cross-refs' Tailwind token
// pass ~1.1 s, slots ~0.6 s, the source snapshot ~0.6 s, the other facets the
// rest) — so the slow-op report stays up until that cost is fixed, instead of a
// 15 s budget declaring it fine.
export const pluginTreeWarmup = defineWarmup({
  name: "plugin-tree.trees",
  description:
    "Pre-builds the plugin trees after startup so Studio opens without a slow first load.",
  scope: "host",
  run: async () => {
    await getStructureTreeCached();
    await getFacetsTreeCached();
  },
});
