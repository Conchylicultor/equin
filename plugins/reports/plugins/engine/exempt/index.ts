import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sink-safety/no-adhoc-file-sink",
    paths: ["server/internal/crash-append.ts"],
    kind: "sanctioned",
    reason:
      "The crash buffer appends inside an `uncaughtException` handler on a dying event loop, with drain-then-unlink queue semantics no channel offers, so it cannot route through a declared sink.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/crash-append.ts"],
    kind: "debt",
    task: "task-1793970457-7rrcc4",
    reason:
      "appendReportSync / reportServerFatalSync must stay synchronous on a dying event loop (uncaughtException, before a deliberate process.exit), but the same sync API is also called where the backend lives on (an unhandledRejection survived, forfeit.ts's narrower-runner forfeit, runner-watch's latch-suppressed exit): split the dying-path append from an async one for the surviving callers.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/buffer.ts", "server/internal/crash-append.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
