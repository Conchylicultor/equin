import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/run-terminal.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "config-v2:host-registrations-paired",
    paths: ["server/index.ts"],
    kind: "debt",
    task: "task-1792587898-4m2kk6",
    reason:
      "build's server barrel (jobs, git-watcher trigger, build routes) is not portable, so the demo worker cannot boot its ConfigV2.Register.",
  },
] satisfies Exemptions;
