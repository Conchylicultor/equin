// Eagerly pull the tasks-core core module into the web import graph so its
// ResourceDescriptors self-register (each `liveValue(...)` /
// `liveCollection(...)` call registers into the live-state key→descriptor map
// on module evaluation).
//
// tasks / conversations-* (incl. the `conversations-gone:count` total) are
// boot-critical (preloaded; served in ../server). boot-snapshot
// resolves every boot-critical key to its client descriptor via
// `resourceDescriptorByKey` BEFORE first paint — so the descriptor module must
// sit in the EAGER web import graph, not behind a lazy boundary. The `pushes`
// collection (`pushRows`) registers here too but is not preloaded.
//
// tasks-core is the schema/repository layer and ships no UI of its own: its
// descriptors reach the web graph today only through consumers (e.g. tasks/web).
// Anchoring the eager registration here ties it to the plugin that OWNS the
// resources rather than to whichever consumer happens to import core.
import "@plugins/tasks/plugins/tasks-core/core";
