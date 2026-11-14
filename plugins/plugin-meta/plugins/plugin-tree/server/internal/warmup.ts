import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  getFacetsTreeCached,
  getStructureTreeCached,
} from "./structure-tree-cache";

// Host-scoped boot warm-up for the two in-memory plugin-tree caches. Both memos
// die with the process, so on main — which restarts on every deploy — the first
// Studio/plugin-view request of each process would otherwise wait for both
// trees (the first `composition.data` / `plugin-view.facets-tree` live read).
// Pre-building here moves that wait off the interactive path into the drain's
// throttled post-boot window. `host` scope: worktree backends skip it — their
// Studio surfaces are rarely opened. They keep the lazy cold path.
//
// The faceted tree is not built in this process: it is held by a worker
// thread (`plugin-tree/faceted`), read as data (`getFacetsTreeCached`), so its
// facet CPU (once ~4–5 s of this thread's, 2026-10-31) runs off the event loop,
// and is mostly record reads at that. After this cold build it follows edits by
// what changed.
//
// The two are built side by side: neither reads the other (the worker takes
// its own snapshot and structure), so starting the worker only once the
// backend's structure was built added that build's wall time (0.2–0.8 s on
// main's boots) to the warm-up's for nothing.
export const pluginTreeWarmup = defineWarmup({
  name: "plugin-tree.trees",
  description:
    "Pre-builds the plugin trees after startup so Studio opens without a slow first load.",
  scope: "host",
  run: async () => {
    await Promise.all([getStructureTreeCached(), getFacetsTreeCached()]);
  },
});
