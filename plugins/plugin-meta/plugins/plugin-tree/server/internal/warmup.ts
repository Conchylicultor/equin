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
// The faceted tree is not built in this process: it is the
// `plugin-tree-facets` command's output, read as data (`getFacetsTreeCached`),
// so its facet CPU (once ~4–5 s of this thread's, 2026-10-31) is a child's,
// and mostly record reads at that.
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
