/**
 * `keysInFlight` on the desktop queue: **a keyed run is in flight while it
 * holds a live row OR a pending wait, read in one statement.** A run moves
 * between the two (suspend: wait first, then the row goes; resume: wait
 * resolved and row inserted in one transaction), so a single snapshot never
 * sees it with neither. Two reads did, and the conversations status sweep took
 * a spawn resuming from its checkout wait for a dead one (2026-11-04).
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";
import { _jobWaits } from "../../server/internal/tables";
import { keysInFlightOn } from "./graphile-queue";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "keys_in_flight_test" });
  await runMigrations(t.db);
  await installQueueSchema(t.connectionString);
});

afterAll(async () => {
  await t.drop();
});

const NAME = "jobs.keys-in-flight-test";
const job = defineJob({
  name: NAME,
  description: "Test job.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: () => {
    throw new Error(
      "[jobs] keys-in-flight-test job was dispatched; this suite starts no worker",
    );
  },
});

const keyOf = (k: string): string => `${NAME}:${k}`;

async function pendingWait(k: string, status = "pending"): Promise<void> {
  await t.db.insert(_jobWaits).values({
    workflowRunId: keyOf(k),
    waitName: "w:0",
    status: status as "pending",
  });
}

describe("keysInFlight", () => {
  test("a queued row is in flight", async () => {
    await t.db.transaction((tx) => job.enqueue({ key: "queued" }, { tx }));
    expect(await keysInFlightOn(t.db, [keyOf("queued")])).toEqual(
      new Set([keyOf("queued")]),
    );
  });

  test("a run suspended on a pending wait, with no row, is in flight", async () => {
    await pendingWait("suspended");
    expect(await keysInFlightOn(t.db, [keyOf("suspended")])).toEqual(
      new Set([keyOf("suspended")]),
    );
  });

  test("a resolved wait with no row is not", async () => {
    await pendingWait("resolved", "resolved");
    expect(await keysInFlightOn(t.db, [keyOf("resolved")])).toEqual(new Set());
  });

  test("a dead row (past its attempts, unlocked) is not", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ key: "dead" }, { tx, maxAttempts: 1 }),
    );
    await t.db.execute(
      sql`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE id = ${jobId}::bigint`,
    );
    expect(await keysInFlightOn(t.db, [keyOf("dead")])).toEqual(new Set());
  });

  test("only the asked keys are answered", async () => {
    expect(
      await keysInFlightOn(t.db, [keyOf("suspended"), keyOf("absent")]),
    ).toEqual(new Set([keyOf("suspended")]));
  });
});
