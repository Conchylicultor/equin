import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { HostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import { db, DatabaseDriver } from "@plugins/database/server";
import { createPgliteDriver } from "@plugins/database/plugins/pglite/server/testing";
import {
  applySchemaLayer,
  isMigrationFileName,
  migrationsFrom,
} from "@plugins/database/plugins/migrations/server";
import { MIGRATIONS_DATA_DIR } from "@plugins/database/plugins/migrations/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  JobQueue,
  type JobTaskPayload,
  type QueuedJob,
} from "@plugins/infra/plugins/jobs/server";
import { createInProcessQueue, settleJobQueue } from "./in-process-queue";

// The queue's rows in a browser host's own database, across a reload: rows
// queued — one in a transaction that commits, one in a transaction that rolls
// back, one keyed twice — while the host has not run them; the host ends (its
// database closed, as when the last tab closes); a new host opens the SAME
// stored database (PGlite on disk, the engine a browser keeps in IndexedDB)
// and runs exactly what was committed.
//
// In a FRESH bun process (this file, re-run as a child), as every PGlite suite:
// PGlite picks its environment from `typeof window`, which an earlier suite in
// the shared process may have stubbed.

setDefaultTimeout(300_000);

const IN_CHILD = process.env.IN_PROCESS_DURABLE_CHILD === "1";

if (!IN_CHILD) {
  test("the in-process queue's rows survive a reload (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, IN_PROCESS_DURABLE_CHILD: "1" },
        timeoutMs: 280_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `in-process durable child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
  });
}

/** A persistent storage over a directory: the driver opens PGlite on it. */
function diskStorage(dir: string): HostStorage & { close(): Promise<void> } {
  const adopted: Parameters<HostStorage["adopt"]>[0][] = [];
  return {
    kind: "persistent",
    databaseDir: dir,
    store: () => {
      throw new Error("no host stores in this test");
    },
    adopt: (r) => adopted.push(r),
    async close() {
      for (const r of adopted) await r.close();
    },
  };
}

/** One host's life on the stored database: its driver provided, `fn` run. */
async function asHost<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const storage = diskStorage(dir);
  const driver = createPgliteDriver({ storage: () => storage });
  await driver.ready({ warm: false });
  try {
    return await withHostServices([DatabaseDriver.provide(driver)], fn);
  } finally {
    await storage.close();
  }
}

const job = (name: string): QueuedJob => ({ name, hold: "instant" });
const payload = (jobName: string, input: unknown = {}): JobTaskPayload => ({
  jobName,
  input,
});

describe.if(IN_CHILD)("the in-process queue on a stored database", () => {
  const dir = mkdtempSync(join(tmpdir(), "in-process-durable-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a row queued before the host ended runs in the next host; a rolled-back one never does", async () => {
    // The host that ends before running anything.
    await asHost(dir, async () => {
      const all = migrationsFrom(
        readdirSync(join(REPO_ROOT, MIGRATIONS_DATA_DIR))
          .filter(isMigrationFileName)
          .map((file) => ({
            file,
            sqlText: readFileSync(
              join(REPO_ROOT, MIGRATIONS_DATA_DIR, file),
              "utf8",
            ),
          })),
      );
      await applySchemaLayer(
        db as unknown as NodePgDatabase,
        all,
        {
          views: [],
          derivedTables: [],
          updatedAtSpecs: [],
          triggers: [],
          claimedTriggerSets: [],
        },
        { commit: true, deferContract: false },
      );
      // Never started: a tab closed before its debounce ran.
      const queue = createInProcessQueue({
        runRow: () => {
          throw new Error("the first host runs nothing");
        },
      });
      await db.transaction(async (tx) => {
        await queue.enqueue(job("history"), payload("history", { v: 1 }), {
          tx,
          runAt: new Date(Date.now() + 4000),
        });
      });
      await db
        .transaction(async (tx) => {
          await queue.enqueue(job("rolled-back"), payload("rolled-back"), {
            tx,
          });
          throw new Error("rollback");
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error) || err.message !== "rollback") throw err;
        });
      // Keyed twice: one row, the newer payload.
      await queue.enqueue(job("index"), payload("index", { v: 1 }), {
        jobKey: "index:page",
      });
      await queue.enqueue(job("index"), payload("index", { v: 2 }), {
        jobKey: "index:page",
      });
      await queue.stop();
    });

    // The next host, on the same stored database.
    const ran: unknown[] = [];
    await asHost(dir, async () => {
      const queue = createInProcessQueue({
        runRow: async (p, meta) => {
          ran.push([p.jobName, p.input, meta.attempt]);
          return { kind: "completed" };
        },
      });
      await withHostServices([JobQueue.provide(queue)], async () => {
        await queue.start();
        await settleJobQueue();
        await queue.stop();
      });
      const left = await executeRows(db, {
        query: sql`SELECT count(*)::int AS n FROM jobs_in_process_rows`,
        row: z.object({ n: z.number() }),
      });
      expect(left).toEqual([{ n: 0 }]);
    });
    expect(
      [...ran].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ).toEqual([
      ["history", { v: 1 }, 1],
      ["index", { v: 2 }, 1],
    ]);
  });
});
