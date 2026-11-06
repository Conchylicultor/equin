import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/latch.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "watcher-safety/no-raw-fs-watch",
    paths: ["server/internal/latch.ts"],
    kind: "sanctioned",
    reason:
      "The duress gate's held copy is kept current by ONE non-recursive, non-persistent fs.watch on the latch directory, filtered to one filename — per process, opened by the plugin's onReadyBlocking (or the first gate read). A defineFileWatcher cannot serve it: this plugin is a leaf imported by processes with no plugin runtime to mount a declaration in (the CLI's admission valve, the cluster sentinel's worker thread) and by tests that never boot one, and @parcel/watcher's native addon would join the CLI's startup closure through the barrel. Not a cycle: file-watcher reaches only runtime-profiler.",
  },
] satisfies Exemptions;
