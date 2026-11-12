import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The test harvest: one `<opId>.json` per finished `./equin test` run
 * (`TestRunRecord`, core `run-record.ts`), written by the run that led it.
 * Every backend ingests the directory into its own tables (`debug/tests`),
 * which is how a run in any worktree reaches every page.
 *
 * Host-global on purpose: a run on code that later lands on main unchanged is
 * a verdict on main — its digest says so — wherever it ran.
 */
export const testRunRecordsDir = defineDataDir({
  kind: "state",
  name: "test-runs",
  owner: "framework/cli/test",
  description:
    "Harvested `./equin test` verdicts, one JSON record per run (each test file's outcome under its import-closure digest), ingested by every backend's Debug → Tests page",
  // A record is ingested within seconds by every running backend; a backend
  // that was down re-reads the dir at boot. Deleting one loses that run's
  // verdicts for backends that never ingested it — observability, never
  // correctness. Writers prune past 14 days themselves.
  reclaim: { kind: "ttl", ttlDays: 14 },
});

export default [testRunRecordsDir];
