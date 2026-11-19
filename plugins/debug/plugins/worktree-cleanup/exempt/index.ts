import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/scan-served.ts"],
    kind: "sanctioned",
    reason:
      "debug.worktree-cleanup.worktrees joins the attempts / tasks rows with the disk (each checkout's dir and git status) and the cluster's database list, scanned ONCE per question at its instant `at` by the scan its `whileSubscribed` starts — a snapshot frozen by design (Refresh is a new question; this panel's own deletes re-read their rows through refreshScannedRows). Its loader and meta read only the in-memory scan. The lexical scan of the serveValue call reaches the scan's listAttempts / listTasks through whileSubscribed.",
  },
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["server/internal/handle-delete.ts"],
    kind: "sanctioned",
    reason: "400/404 guards emitted before an NDJSON stream response.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/dirs.ts",
      "server/internal/hygiene-witness.ts",
      "server/internal/reap-policy.ts",
      "server/internal/reap.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/worktree-cleanup-panel.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — WorktreeCleanupPanel (unsupported syntax: Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement), DeleteAction (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause).",
  },
] satisfies Exemptions;
