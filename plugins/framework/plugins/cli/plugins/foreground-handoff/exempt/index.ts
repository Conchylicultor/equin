import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "watcher-safety/no-raw-fs-watch",
    paths: ["cli/handoff.ts"],
    kind: "sanctioned",
    reason:
      "The foreground hand-off streams ONE file — the detached op's own output — to the agent's call while it waits on that op, for at most one call's time limit, closed when the op exits or is handed off. It runs on every foreground check/test, so it takes the lightest possible watch (a single fs.watch on one file) rather than loading @parcel/watcher's native addon into the CLI's startup closure. A foreground wait, not background activity: there is no catalog entry to report into.",
  },
] satisfies Exemptions;
