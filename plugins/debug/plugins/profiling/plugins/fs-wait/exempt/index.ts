import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/record-fs-waits.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "not yet split into server/ + machine/ — a machine/ barrel would fit (it writes the computer's disk), but the CLI entry (framework/cli bin/) that also calls it may not import a machine barrel",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/record-fs-waits.ts"],
    kind: "sanctioned",
    reason:
      "Only the process `exit` handler writes synchronously (the lines still queued, then the open episode's summary): an exit handler cannot wait for a queued write, and the process is ending. Every other line goes through the async append.",
  },
] satisfies Exemptions;
