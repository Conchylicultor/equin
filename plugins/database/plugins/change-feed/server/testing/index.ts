// Creating the change-feed's changelog table in a suite's own database, without
// rebuilding every trigger.
export { ensureChangelogTable } from "../internal/triggers";
// An isolated LISTEN consumer on a suite's own database (the production one
// opens the host driver's session), routing through whatever `route` the suite
// hands it — `routeChange` for the real runtime.
export {
  createChangeFeedListener,
  type TestChangeFeedListenerOptions,
} from "./listener";
// `routeChange`'s routing into a runtime of the suite's own
// (`createResourceRuntime`) instead of server-core's global one — so a suite
// registering REAL declarations (the tree oracle) never collides with the keys
// a barrel's module eval registered on the global registry.
export { createChangeRouter } from "../internal/route-change";
// The feed's triggers on a suite's own throwaway database (with the suite's
// own exclusions — nothing is contributed in an un-booted process).
export { rebuildTriggers } from "../internal/triggers";
// A change producer live in a suite that never booted the plugin graph (its
// changes routed through the suite's `route`, the real `routeChange` by
// default), and its coalescing window flushed by hand.
export { flushNow, mountProducersForTest } from "../internal/producer"; // The boot checks a produced table's readers must pass (A3p: no route needs a
// carried column; A1′: every route table of a routed resource has a change source),
// for a suite that registers a REAL produced collection without booting the feed.
export { findCarriedProducedRoutes } from "../internal/produced-tables";
export { assertRouteTablesCovered } from "../internal/route-coverage";
// The layout a table's installed `live_state_*` triggers emit, read back from
// the catalog (the PK and carried columns of each), for a suite asserting what
// the routes it registered actually installed.
export {
  installedLayouts,
  readInstalledTriggers,
} from "../internal/route-layout";
// A3, the boot assert itself: the installed triggers emit every column the
// routes carry — for a suite proving a route kind's layout is checked (a
// rollup's source routes, query-resource's C14 suite).
export { assertRouteLayoutsInstalled } from "../internal/route-layout";
// Relation bases over a suite's own database: its views' read graph
// (`buildViewDeps`) expanded with its rollups (`createRelationBases`) — what a
// suite's own runtime takes as `relationBases`, as the boot graph is for the
// server's.
export { buildViewDeps } from "../internal/view-deps";
export { createRelationBases } from "../internal/relation-bases";
// The boot install itself (change-feed's graph AND server-core's holder), for
// a suite proving the wiring reaches server-core's router.
export { installRelationGraph } from "../internal/relation-bases";
