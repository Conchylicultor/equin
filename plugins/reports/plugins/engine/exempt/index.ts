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
    kind: "sanctioned",
    reason:
      "The dying path's crash-buffer append: its only callers are the processCrashSink handler's crash-buffer-sync lane — an uncaught exception on the serving backend, the listener exits 1 next (crashWriteLane decides every lane in one place) and the serverFatalSink handler, which only server-core's exitWithFatalReport emits (it takes the exit and returns never). The process exits on the caller's next statement, so an async write would never land. Every path a serving backend survives (a rejection, reportServer) records asynchronously.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/buffer.ts", "server/internal/crash-append.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
