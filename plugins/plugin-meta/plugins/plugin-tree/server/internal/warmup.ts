import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import {
  getFacetsTreeCached,
  getStructureTreeCached,
} from "./structure-tree-cache";

// Host-scoped boot warm-up for the two in-memory plugin-tree caches. The full
// facets build is ~5s of pure CPU (every plugin × every facet extractor) and
// both memos die with the process, so on main — which restarts on every deploy —
// the first Studio/plugin-view request of each process paid the whole build
// synchronously (the first `composition.data` / `plugin-view.facets-tree` live
// read; formerly slow-op GET /api/composition/data, 5–42s per cold hit).
// Pre-building here moves that cost off the interactive path into the drain's
// throttled post-boot window. `host` scope: worktree backends skip it — their
// Studio surfaces are rarely opened, and N×-worktree boots would multiply a 5s
// CPU burn exactly when the host is busiest. They keep the lazy cold path.
export const pluginTreeWarmup = defineWarmup({
  name: "plugin-tree.trees",
  description:
    "Pre-builds the plugin trees after startup so Studio opens without a slow first load.",
  scope: "host",
  budgetMs: 15_000,
  run: async () => {
    await getStructureTreeCached();
    await getFacetsTreeCached();
  },
});
