import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "daemon/no-raw-worker",
    paths: ["."],
    kind: "sanctioned",
    reason: "The daemon primitive itself is where the one `new Worker` lives.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/registry.ts", "server/internal/pid-file-sync.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/pid-file-sync.ts"],
    kind: "debt",
    task: "task-1793970457-7rrcc4",
    reason:
      "The pid-file arms' observe() re-reads the pid file on every sync instance.pid / instance.state get and listDaemons: the file should be watched and its read pushed, so a get reads memory.",
  },
] satisfies Exemptions;
