// Test helpers of server-core's core runtime.
//
// The runtime-owned loader → table read-set, read back whole: a suite that
// drives a real loader (through the profiler's ambient entry and the DB pool
// chokepoint) asserts the tables it captured.
export { getReadSetIndex } from "../read-set";

// Its one eviction path: a suite isolating its own keys from another suite's
// captures drops a table from every other key's read-set (display state).
export { removeReadSetTable } from "../read-set";

// Relation bases are a process-global holder (`setRelationBases`): a suite
// that installs some resets it after, so the next suite in the same bun process
// still sees the "read before set" throw.
export { clearRelationBases } from "../resources";

// Collected contributions are process-global: a suite that boots (or fakes) a
// collect resets it, so a later "read before collect" assertion still holds.
export { clearCollectedContributions } from "../contributions";

// Declared host services are process-global too: a suite that declares some
// forgets them after, so the next suite's boot assert does not demand them.
export { clearHostServices } from "../host-service";

// A headless test process boots no graph, yet runs code that reads host
// services (`db`, the job queue): the `bun test` preload names the desktop
// host's providers through this.

// A suite that swaps some host services for one call — its own fixtures over
// the preload's desktop providers (or a faked collect's) — without leaking them
// into the next suite.
export { withHostServices } from "../host-service";

// The one boot sequence, for a suite that boots a plugin graph of its own (the
// portable boot test boots task-category's closure on PGlite).
export { bootPluginGraph } from "../boot-stages";

// The app's server registry (the committed `singularity` composition), for a
// suite that boots a slice of it: each entry's loader and its codegen-derived
// `dependsOn`, from which a `dependsOn` closure is the graph to boot.
export { serverEntries } from "../server.generated";

// A registry entry for a plugin the app's registry does not hold (a provider
// `base-exclusions` keeps out of every desktop composition), loaded the way the
// registry loads one — for a suite booting a graph with it.
export { serverEntryFor } from "./server-entry";
