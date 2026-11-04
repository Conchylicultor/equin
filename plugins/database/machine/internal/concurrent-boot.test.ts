/**
 * Concurrent process boots of the DB layer cannot race on a catalog write.
 *
 * Every process that boots the database plugin — the server and each
 * supervised `exec` child (worktree.prepare, spare refill, cleanup) — runs the
 * desktop driver's `ready()`. It used to `ALTER DATABASE … SET
 * idle_in_transaction_session_timeout` there, and when several booted at once
 * Postgres failed one with `XX000 tuple concurrently updated` (2026-11-04).
 * The setting is now the cluster's (`database/embedded`'s
 * `applyClusterSettings`, run once per cluster start), so a boot writes no
 * per-database setting at all.
 *
 * Proven on the real thing: BOOTS fresh bun processes (this file re-run as a
 * child with `CONCURRENT_BOOT_CHILD` set — `ready()` is a per-process
 * singleton, so in-process calls would collapse into one) boot the driver
 * against this checkout's database at the same moment; every one must
 * succeed, and the database's `pg_db_role_setting` row (absent, or left by an
 * older build) must be untouched — an `ALTER DATABASE SET` of even the same
 * value rewrites the row, so its xmin would move.
 *
 * Run: `./equin test plugins/database/machine`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { sql } from "drizzle-orm";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { pgDriver } from "./pg-driver";

const IN_CHILD = process.env.CONCURRENT_BOOT_CHILD === "1";
const BOOTS = 6;

setDefaultTimeout(240_000);

if (IN_CHILD) {
  test("boot the desktop driver (child)", async () => {
    await pgDriver.ready({ warm: false });
  });
} else {
  describe("concurrent DB-layer boots", () => {
    test(`${BOOTS} processes booting at once all succeed and write no per-database setting`, async () => {
      const before = await roleSettingVersions();

      const results = await Promise.all(
        Array.from({ length: BOOTS }, () =>
          spawnCaptured([process.execPath, "test", import.meta.path], {
            // The repo root, so the child reads the same bunfig (test preload).
            cwd: REPO_ROOT,
            env: { ...process.env, CONCURRENT_BOOT_CHILD: "1" },
            timeoutMs: 180_000,
          }),
        ),
      );
      for (const r of results) {
        if (r.exitCode !== 0) {
          throw new Error(
            `a concurrent boot exited ${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
          );
        }
      }

      expect(await roleSettingVersions()).toEqual(before);
    });
  });
}

// Every `pg_db_role_setting` row of this checkout's database, by its row
// version: a write of any value, the same one included, moves `xmin`. Read
// through this process's own driver (`pg_db_role_setting` is a shared catalog).
async function roleSettingVersions(): Promise<
  { role: string; xmin: string }[]
> {
  return executeRows(pgDriver.db(), {
    query: sql`SELECT s.setrole::text AS role, s.xmin::text AS xmin
                 FROM pg_db_role_setting s
                 JOIN pg_database d ON d.oid = s.setdatabase
                WHERE d.datname = current_database()
                ORDER BY s.setrole`,
    row: z.object({ role: z.string(), xmin: z.string() }),
  });
}
