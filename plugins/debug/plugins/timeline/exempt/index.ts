import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/scan-served.ts"],
    kind: "sanctioned",
    reason:
      "debug.timeline.scan's truth is every fork DB and every worktree's log files, which no change feed of this backend sees. Its loader reads only the in-memory scan; the one read of this backend's Postgres is `listAttempts` (via listLiveForkDatabases) inside the scan its `whileSubscribed` starts, choosing which forks count as live for the window frozen at the question's `at` (Refresh is a new question), so no write to `attempts` may move a scan already asked. The lexical scan of the serveValue call reaches it through whileSubscribed.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/mcp-tool.ts", "server/internal/sources/health.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/log-dirs.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
