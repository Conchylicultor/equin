import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["server/internal/service.ts"],
    kind: "sanctioned",
    reason:
      "Main's dead-op sweep: a hard-killed op leaves no filesystem event, only a marker that stops being locked, so its death can only be seen by looking — real polling awaiting a push replacement. Main only (one sweep host-wide); every other backend hears the resulting terminal through its op-log watcher.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/ingest.ts", "server/internal/service.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
