/**
 * `keysInFlight` on the desktop queue: **a keyed run is in flight while it
 * holds a live row OR a pending wait whose waker still holds its key, read in
 * one statement.** A run moves
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
import { dyingRunIds, markRunDying } from "./dying-runs";
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

async function pendingWait(
  k: string,
  status = "pending",
  wakerKey: string | null = null,
): Promise<void> {
  await t.db.insert(_jobWaits).values({
    workflowRunId: keyOf(k),
    waitName: "w:0",
    status: status as "pending",
    wakerKey,
  });
}

/** The wait's timeout racer: a `jobs.resume` row holding `wakerKey`. */
const racer = defineJob({
  name: "jobs.keys-in-flight-test-racer",
  description: "Test racer.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: () => {
    throw new Error("[jobs] racer dispatched; this suite starts no worker");
  },
});
const racerKeyOf = (k: string): string => `jobs.keys-in-flight-test-racer:${k}`;

async function lockRow(jobId: string, attempts: number): Promise<void> {
  await t.db.execute(
    sql`UPDATE graphile_worker._private_jobs
           SET attempts = ${attempts}, locked_at = now(), locked_by = 'test'
         WHERE id = ${jobId}::bigint`,
  );
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

  // The 2026-11-05 hang: a spawn parked on its checkout wait counted as
  // coming for as long as the wait stayed pending — forever, once the
  // `jobs.resume` that was to wake it had dead-lettered.
  test("a pending wait whose waker row still holds its key is in flight", async () => {
    await t.db.transaction((tx) =>
      racer.enqueue({ key: "live-waker" }, { tx }),
    );
    await pendingWait("live-waker", "pending", racerKeyOf("live-waker"));
    expect(await keysInFlightOn(t.db, [keyOf("live-waker")])).toEqual(
      new Set([keyOf("live-waker")]),
    );
  });

  test("a pending wait whose waker dead-lettered is not — nothing will wake it", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      racer.enqueue({ key: "dead-waker" }, { tx, maxAttempts: 1 }),
    );
    await t.db.execute(
      sql`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE id = ${jobId}::bigint`,
    );
    await pendingWait("dead-waker", "pending", racerKeyOf("dead-waker"));
    expect(await keysInFlightOn(t.db, [keyOf("dead-waker")])).toEqual(
      new Set(),
    );
  });

  test("a pending wait whose waker row is gone (cancelled, GC'd) is not", async () => {
    await pendingWait("no-waker", "pending", racerKeyOf("no-waker"));
    expect(await keysInFlightOn(t.db, [keyOf("no-waker")])).toEqual(new Set());
  });

  test("a running last attempt is in flight until its dispatch declares it dead", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ key: "dying" }, { tx, maxAttempts: 2 }),
    );
    await lockRow(jobId, 2);
    expect(await keysInFlightOn(t.db, [keyOf("dying")])).toEqual(
      new Set([keyOf("dying")]),
    );
    // Still locked: graphile's fail write has not landed.
    expect(await keysInFlightOn(t.db, [keyOf("dying")], [jobId])).toEqual(
      new Set(),
    );
    // A dying mark on another row says nothing about this one.
    expect(await keysInFlightOn(t.db, [keyOf("dying")], ["0"])).toEqual(
      new Set([keyOf("dying")]),
    );
  });

  test("a waker on its dying last attempt no longer holds the wait", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      racer.enqueue({ key: "dying-waker" }, { tx, maxAttempts: 1 }),
    );
    await lockRow(jobId, 1);
    await pendingWait("dying-waker", "pending", racerKeyOf("dying-waker"));
    expect(await keysInFlightOn(t.db, [keyOf("dying-waker")], [jobId])).toEqual(
      new Set(),
    );
  });

  test("a re-launch of a dying run's key is a new row, in flight whatever the old mark", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ key: "relaunched" }, { tx, maxAttempts: 1 }),
    );
    await t.db.execute(
      sql`UPDATE graphile_worker._private_jobs SET attempts = 1 WHERE id = ${jobId}::bigint`,
    );
    markRunDying(jobId);
    // graphile retires the dead row and inserts a fresh one — a new id, so
    // the mark the dead run left cannot hide the run that is coming now.
    const again = await t.db.transaction((tx) =>
      job.enqueue({ key: "relaunched" }, { tx, maxAttempts: 1 }),
    );
    expect(again.jobId).not.toBe(jobId);
    await lockRow(again.jobId, 1);
    expect(
      await keysInFlightOn(t.db, [keyOf("relaunched")], dyingRunIds()),
    ).toEqual(new Set([keyOf("relaunched")]));
  });

  test("only the asked keys are answered", async () => {
    expect(
      await keysInFlightOn(t.db, [keyOf("suspended"), keyOf("absent")]),
    ).toEqual(new Set([keyOf("suspended")]));
  });
});
