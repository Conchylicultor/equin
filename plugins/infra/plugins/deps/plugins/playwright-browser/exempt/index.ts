import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/executables.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/executables.ts"],
    kind: "sanctioned",
    reason:
      "The browser executables Playwright recorded in this install's env/ record: files of the app's own deps install, written by it, never a path a user chose.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["deps/internal/playwright-browser.ts"],
    kind: "debt",
    task: "task-1793991088-yd3u37",
    reason:
      "Calls a *Sync helper (or a sync child process) that has no async twin yet; blocks the backend's thread for as long as the disk or the child takes.",
  },
] satisfies Exemptions;
