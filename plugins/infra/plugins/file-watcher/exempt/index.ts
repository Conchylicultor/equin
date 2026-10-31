import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "watcher-safety/no-direct-parcel-watcher",
    paths: ["shared"],
    kind: "sanctioned",
    reason:
      "The single sanctioned chokepoint for loading @parcel/watcher: the file-watcher engine (`shared/engine.ts`) and its siblings own the native-addon loader.",
  },
  {
    rule: "watcher-safety/no-raw-fs-watch",
    paths: ["shared/engine.ts"],
    kind: "sanctioned",
    reason:
      "The engine's `children` depth: a single-directory watch is the platform's `fs.watch` without `recursive` (parcel only watches recursively). It is opened only through the engine, so every instance is a declared, catalogued `defineFileWatcher` like a parcel one.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/dir-hub.ts",
      "shared/engine.ts",
      "shared/journal.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
