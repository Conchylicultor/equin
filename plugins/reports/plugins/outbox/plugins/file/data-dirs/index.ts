import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The report outbox: one JSON file per report a process with no server filed
 * (a CLI run, a supervised child), waiting for main's backend to record it.
 *
 * Host-global rather than per-worktree for the same reason the crash buffer
 * next door is: the writer is a process in ANY checkout, and the one reader is
 * main. A per-worktree dir would need main to discover every worktree's.
 *
 * @see plugins/reports/plugins/outbox/plugins/file/core/internal/file-report.ts (writer)
 * @see plugins/reports/plugins/outbox/server/internal/drain.ts (reader)
 */
export const reportOutboxDir = defineDataDir({
  kind: "state",
  name: "report-outbox",
  owner: "reports/outbox/file",
  description:
    "Reports filed by processes with no server (CLI runs, supervised children), one JSON file each, drained into the reports table by main's backend",
  // Until main drains an entry, the file IS the report — nothing else holds it.
  // The writer caps the directory, so it cannot grow without bound while main
  // is down.
  reclaim: {
    kind: "never",
    reason:
      "an undrained entry is the only record of that report until main's backend files it",
  },
});

export default [reportOutboxDir];
