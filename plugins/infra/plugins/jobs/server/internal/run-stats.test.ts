/**
 * The run history's ring: run N lands in slot (N - 1) % RECENT_RUNS_RING, the
 * stats row counts every run, and a wrapped ring keeps exactly the newest
 * RECENT_RUNS_RING runs. The one-statement upsert is checked against a real
 * database (`db-test-fixture`), since the slot is derived IN SQL from the
 * counter the same statement increments.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./singularity build` first).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  RECENT_RUNS_RING,
  recordJobRun,
  ringSlot,
  type JobRunRecord,
} from "./run-stats";

describe("ringSlot", () => {
  test("run 1 is slot 0, and the ring wraps after RECENT_RUNS_RING runs", () => {
    expect(ringSlot(1)).toBe(0);
    expect(ringSlot(RECENT_RUNS_RING)).toBe(RECENT_RUNS_RING - 1);
    expect(ringSlot(RECENT_RUNS_RING + 1)).toBe(0);
    expect(ringSlot(2 * RECENT_RUNS_RING + 3)).toBe(2);
  });

  test("a run number that is not a positive integer is refused", () => {
    expect(() => ringSlot(0)).toThrow();
    expect(() => ringSlot(1.5)).toThrow();
  });
});

describe("recordJobRun", () => {
  let t: TestDb;

  // The two tables as the generated migration creates them — this suite runs
  // no migration chain, only the statement under test.
  beforeAll(async () => {
    t = await createTestDb({ prefix: "run_stats_test" });
    await t.db.execute(sql`
      CREATE TABLE job_run_stats (
        job_name text PRIMARY KEY,
        last_started_at timestamptz NOT NULL,
        last_finished_at timestamptz NOT NULL,
        last_outcome text NOT NULL,
        last_error text,
        last_duration_ms integer NOT NULL,
        last_success_at timestamptz,
        runs integer NOT NULL,
        failures integer NOT NULL
      )`);
    await t.db.execute(sql`
      CREATE TABLE job_runs (
        id text PRIMARY KEY GENERATED ALWAYS AS (job_name || ':' || seq::text) STORED,
        job_name text NOT NULL,
        slot integer NOT NULL,
        seq integer NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL,
        outcome text NOT NULL,
        error text,
        duration_ms integer NOT NULL,
        attempt integer NOT NULL,
        job_id text,
        hold text,
        max_attempts integer,
        queued_at timestamptz,
        input jsonb
      )`);
    await t.db.execute(sql`
      CREATE UNIQUE INDEX job_runs_job_name_slot_idx ON job_runs (job_name, slot)`);
  });

  afterAll(async () => {
    await t.drop();
  });

  function run(i: number, outcome: JobRunRecord["outcome"]): JobRunRecord {
    const startedAt = new Date(Date.UTC(2026, 8, 30, 0, i));
    return {
      jobName: "ring.probe",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1000),
      outcome,
      error: outcome === "failed" ? `boom ${i}` : null,
      durationMs: 1000,
      attempt: 1,
      jobId: String(1000 + i),
      hold: "instant",
      maxAttempts: 3,
      queuedAt: new Date(startedAt.getTime() - 250),
      input: { i },
    };
  }

  test("counts every run and keeps only the newest ring's worth", async () => {
    const total = RECENT_RUNS_RING + 3;
    for (let i = 1; i <= total; i++) {
      await recordJobRun(t.db, run(i, i === 2 ? "failed" : "succeeded"));
    }

    const [stats] = await executeRows(t.db, {
      label: "run-stats test: stats row",
      row: z.object({
        runs: z.number(),
        failures: z.number(),
        last_outcome: z.string(),
        has_success: z.boolean(),
      }),
      query: sql`SELECT runs, failures, last_outcome,
        last_success_at IS NOT NULL AS has_success FROM job_run_stats`,
    });
    expect(stats).toEqual({
      runs: total,
      failures: 1,
      last_outcome: "succeeded",
      has_success: true,
    });

    const ring = await executeRows(t.db, {
      label: "run-stats test: ring",
      row: z.object({
        id: z.string(),
        slot: z.number(),
        seq: z.number(),
        job_id: z.string(),
        hold: z.string(),
        max_attempts: z.number(),
        wait_ms: z.number(),
        input: z.object({ i: z.number() }),
      }),
      query: sql`SELECT id, slot, seq, job_id, hold, max_attempts,
        (EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000)::integer AS wait_ms,
        input FROM job_runs ORDER BY seq`,
    });
    expect(ring).toHaveLength(RECENT_RUNS_RING);
    // The oldest runs were overwritten; every survivor sits in its own slot,
    // and an overwritten slot carries the NEW run's id and queue facts.
    expect(ring[0]!.seq).toBe(total - RECENT_RUNS_RING + 1);
    for (const r of ring) {
      expect(r.slot).toBe(ringSlot(r.seq));
      expect(r.id).toBe(`ring.probe:${r.seq}`);
      expect(r.job_id).toBe(String(1000 + r.seq));
      expect(r.input).toEqual({ i: r.seq });
      expect(r).toMatchObject({
        hold: "instant",
        max_attempts: 3,
        wait_ms: 250,
      });
    }
  });

  test("a long error is kept whole on the run and previewed on the stats row", async () => {
    const long = "x".repeat(2000);
    await recordJobRun(t.db, { ...run(98, "failed"), error: long });
    const [row] = await executeRows(t.db, {
      label: "run-stats test: error lengths",
      row: z.object({ run_len: z.number(), stats_len: z.number() }),
      query: sql`SELECT
        (SELECT length(error) FROM job_runs ORDER BY seq DESC LIMIT 1) AS run_len,
        (SELECT length(last_error) FROM job_run_stats) AS stats_len`,
    });
    expect(row).toEqual({ run_len: 2000, stats_len: 501 });
  });

  test("a failure after a success keeps the last success time", async () => {
    await recordJobRun(t.db, run(99, "failed"));
    const [row] = await executeRows(t.db, {
      label: "run-stats test: last success kept",
      row: z.object({ last_outcome: z.string(), has_success: z.boolean() }),
      query: sql`SELECT last_outcome, last_success_at IS NOT NULL AS has_success
        FROM job_run_stats`,
    });
    expect(row).toEqual({ last_outcome: "failed", has_success: true });
  });
});
