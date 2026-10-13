// Eagerly pull the op-store core module into the web import graph so its
// collection declarations self-register on module evaluation.
//
// `op-store.in-flight.all` is boot-critical (`preload: "boot"` — the op-status
// banner is first-paint chrome): boot-snapshot resolves its key to the client
// descriptor BEFORE first paint, so the declaring module must be in the EAGER
// graph, owned here by the plugin that declares it rather than by whichever
// consumer happens to import core.
import "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
