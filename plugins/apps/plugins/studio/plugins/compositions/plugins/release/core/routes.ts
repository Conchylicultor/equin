import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { compositionsRoute } from "@plugins/apps/plugins/studio/plugins/compositions/core";

/**
 * One release run's detail pane, in `core/` (as the compositions routes and
 * `build`'s are) so a plugin elsewhere can link to a run without importing this
 * plugin's web barrel and every section component behind it.
 *
 * The parent is the **paramless** compositions route, not `comp/:id`. A run is
 * addressable by its own id and nothing else: every section this pane hosts
 * (info / logs / artifact) reads `useLive(releaseRuns, { id: runId })`, and the
 * composition pane above it supplied no data — only breadcrumb position. Hung
 * off `comp/:id` the pane could only be opened by whoever already held the
 * compositions **config-item uuid**, which `release_runs` does not store (it
 * stores the composition *name*) — so the merged runs list could not open it at
 * all. A route parent is only a hint for opening from scratch, so the release
 * history section, which pushes from inside the composition pane, still nests
 * the run exactly where it always did.
 *
 * Segments are GLOBALLY unique across all panes (not path-scoped): build's
 * run-detail already owns `r/:runId`, so the release run-detail uses `rel/…`.
 */
export const releaseDetailRoute = defineRoute({
  id: "release-detail",
  segment: "rel/:runId",
  parent: compositionsRoute,
});
