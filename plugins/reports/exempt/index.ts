import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["server/internal/buffer.ts"],
    kind: "sanctioned",
    reason:
      "The crash buffer appends inside an `uncaughtException` handler on a dying event loop, with drain-then-unlink queue semantics no channel offers, so it cannot route through a declared sink.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/buffer.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "config-v2:host-registrations-paired",
    paths: ["server/index.ts"],
    kind: "debt",
    task: "task-1792587903-22dhup",
    reason:
      "reports' server barrel (fan-out, database/admin, crash buffer) is not portable, so the demo worker cannot boot its ConfigV2.Register.",
  },
] satisfies Exemptions;
