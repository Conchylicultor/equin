import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  listDatabases,
  dropDatabase,
  countActiveConnections,
  databaseSizeBytes,
} from "@plugins/database/plugins/admin/server";
import {
  parseTestDbName,
  TEST_DB_TTL_MS,
} from "@plugins/database/plugins/db-test-fixture/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";

/**
 * Reclaims throwaway test databases whose test process died before its
 * `afterAll` could drop them.
 *
 * This is the backstop half of the fixture's lifetime. `createTestDb`'s `drop()`
 * is what runs on the normal path; it cannot run at all when the run is killed,
 * and before this job existed nothing else ever did — five killed runs over two
 * weeks in August 2026 left seven databases on the shared cluster, still there a
 * month later, invisible to every cleanup surface on the host because their
 * names told nobody what they were.
 *
 * TWO independent conditions, and a candidate needs both:
 *
 *   1. The name parses as one this fixture minted (`__testdb`). Nothing else
 *      mints that suffix, so this can never match a real namespace — and a
 *      suffixed name that does NOT parse throws rather than being skipped, since
 *      it means the grammar has torn.
 *   2. It is past its TTL *and* has no active connections. Either alone is
 *      unsafe: a fresh mint is briefly connection-less between `ensureDatabase`
 *      and the pool opening, and a suite paused under a debugger is old but very
 *      much alive.
 *
 * EVERY DROP FILES A REPORT. A sweep that deletes quietly is indistinguishable
 * from data going missing, and the facts worth keeping (which suite, which pid)
 * live in the name, which the drop destroys — so the report is both the receipt
 * and the only surviving evidence. Deduped per suite, so a burst collapses onto
 * one row whose count grows.
 *
 * Main-runtime only (no `perWorktree`) and `singleton` — databases are a global
 * cluster resource, so one sweep covers every worktree, exactly as
 * `database.fork-temp-sweep` does for `__forking` temps.
 */
export const testDbSweepJob = defineJob({
  name: "database.test-db-sweep",
  description:
    "Drops throwaway test databases left behind by killed test runs, filing a report for each one dropped.",
  // instant: a catalog query plus a `DROP DATABASE` per orphan — no subprocess,
  // no dump/restore.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "23 * * * *" },
  async run() {
    const now = Date.now();
    for (const name of await listDatabases()) {
      const minted = parseTestDbName(name);
      if (minted === null) continue;
      const ageMs = now - minted.mintedAt;
      if (ageMs < TEST_DB_TTL_MS) continue;
      if ((await countActiveConnections(name)) !== 0) continue;

      // Measured BEFORE the drop — afterwards there is nothing left to measure,
      // and "how much was this costing" is half of why anyone reads the report.
      const bytes = await databaseSizeBytes(name);
      await dropDatabase(name);
      await recordReport({
        kind: "test-database-leaked",
        source: "server-caught",
        message: `A killed ${minted.prefix} run left database ${name} on the cluster`,
        data: { name, ...minted, ageMs, bytes },
      });
    }
  },
});
