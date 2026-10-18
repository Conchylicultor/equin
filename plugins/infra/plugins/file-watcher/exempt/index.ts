import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "detached-work-safety/no-raw-set-interval",
    paths: ["shared/engine.ts"],
    kind: "sanctioned",
    reason:
      "The file-watcher engine's per-INSTANCE reconcile timer: every watcher instance with a declared `reconcileMs` gets one, torn down with it. The `defineFileWatcher` declaration is the unit the catalog lists (under File watchers), and each tick is recorded there as one of its runs; a timer entry per instance would list N copies of one mechanism.",
  },
  {
    rule: "watcher-safety/no-direct-parcel-watcher",
    paths: ["shared"],
    kind: "sanctioned",
    reason:
      "The single sanctioned chokepoint for loading @parcel/watcher: the file-watcher engine (`shared/engine.ts`) and its siblings own the native-addon loader.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/dir-hub.ts", "shared/engine.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
