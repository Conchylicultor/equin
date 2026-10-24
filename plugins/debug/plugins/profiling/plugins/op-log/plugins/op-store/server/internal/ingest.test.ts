/**
 * The ingester and reconciler against a real throwaway Postgres (the REAL
 * migration chain) and a temp-dir op log: rotation between drains, a partial
 * last line, re-drain idempotency, the seed tail's headless ops, and the
 * reconciler with injected liveness.
 *
 * Requires the running embedded cluster (`./equin build` first).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type {
  OpEvent,
  OpSummary,
  OpLine,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { opRowToFoldState } from "../../core/internal/schemas";
import { drainOpLog } from "./ingest";
import { reconcileOps } from "./reconcile";
import { OP_LOG_SOURCE, readCursor } from "./store";
import { _opLogIngestCursor, _opLogOps } from "./tables";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function requested(opId: string, seq = 1, pid = 999_999): OpEvent {
  return {
    v: 2,
    opId,
    seq,
    at: iso(0),
    t: 0,
    e: "requested",
    kind: "build",
    opSlug: "att-test",
    branch: "claude-web/att-test",
    conversationId: null,
    lane: "background",
    mode: null,
    buildId: "b-1",
    pid,
  };
}

const waitStart = (opId: string, seq: number, t: number): OpEvent => ({
  v: 2,
  opId,
  seq,
  at: iso(t),
  t,
  e: "wait-start",
  wait: "duress-valve",
  reason: "loadRatio",
  cycle: 2,
});

const waitEnd = (opId: string, seq: number, t: number): OpEvent => ({
  v: 2,
  opId,
  seq,
  at: iso(t),
  t,
  e: "wait-end",
  wait: "duress-valve",
  startMs: 100,
  durationMs: t - 100,
  result: "cleared",
  reason: "loadRatio",
  cycle: 2,
});

const granted = (opId: string, seq: number, t: number): OpEvent => ({
  v: 2,
  opId,
  seq,
  at: iso(t),
  t,
  e: "granted",
});

function completed(opId: string, seq: number, t: number): OpEvent {
  const summary: OpSummary = {
    kind: "build",
    opSlug: "att-test",
    branch: "claude-web/att-test",
    conversationId: null,
    lane: "background",
    mode: null,
    buildId: "b-1",
    pid: 999_999,
    requestedAt: iso(0),
    grantedAt: iso(500),
    completedAt: iso(t),
    waits: [
      {
        kind: "duress-valve",
        startMs: 100,
        durationMs: 300,
        reason: "loadRatio",
        cycle: 2,
        result: "cleared",
      },
    ],
    holdMs: t - 500,
    totalMs: t,
    outcome: "success",
    interrupted: false,
    steps: [{ name: "vite", startMs: 0, durationMs: 50 }],
  };
  return {
    v: 2,
    opId,
    seq,
    at: iso(t),
    t,
    e: "completed",
    by: "self",
    summary,
  };
}

const line = (x: OpLine) => JSON.stringify(x) + "\n";

let t: TestDb;
let dir: string;
let path: string;

async function row(opId: string) {
  const [r] = await t.db
    .select()
    .from(_opLogOps)
    .where(eq(_opLogOps.opId, opId));
  return r ?? null;
}

const drain = (seedBytes?: number) =>
  drainOpLog({ db: t.db, path, seedBytes, chunkBytes: 64 });

beforeAll(async () => {
  t = await createTestDb({ prefix: "opstore_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM op_log_ops`);
  await t.db.execute(sql`DELETE FROM op_log_ingest_cursor`);
  dir = mkdtempSync(join(tmpdir(), "op-store-"));
  path = join(dir, "op-log.jsonl");
});

describe("drainOpLog", () => {
  test("first drain folds the file and parks the cursor at EOF", async () => {
    writeFileSync(
      path,
      line(requested("op-1")) + line(waitStart("op-1", 2, 100)),
    );
    // 64-byte chunks: one line per batch, so op-1 is written twice.
    expect(await drain()).toMatchObject({ kind: "ok", lines: 2, written: 2 });
    const r = await row("op-1");
    expect(r).toMatchObject({
      kind: "build",
      opSlug: "att-test",
      pid: 999_999,
      closedBy: null,
      lastSeq: 2,
      openWait: {
        kind: "duress-valve",
        reason: "loadRatio",
        cycle: 2,
        startMs: 100,
      },
    });
    const cursor = await readCursor(t.db);
    expect(cursor?.offset).toBe(Bun.file(path).size);
    expect(cursor?.gapAt).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a partial last line waits for its newline", async () => {
    writeFileSync(
      path,
      line(requested("op-1")) + line(waitStart("op-1", 2, 100)),
    );
    await drain();
    const full = line(waitEnd("op-1", 3, 400));
    appendFileSync(path, full.slice(0, 20)); // the writer is mid-append
    expect(await drain()).toMatchObject({ kind: "ok", lines: 0 });
    expect((await row("op-1"))?.openWait).not.toBeNull();
    appendFileSync(path, full.slice(20));
    expect(await drain()).toMatchObject({ kind: "ok", lines: 1 });
    const r = await row("op-1");
    expect(r?.openWait).toBeNull();
    expect(r?.waits).toHaveLength(1);
    expect(r?.closedWaitMs).toBe(300);
    rmSync(dir, { recursive: true, force: true });
  });

  test("re-draining the same bytes changes nothing", async () => {
    writeFileSync(
      path,
      line(requested("op-1")) +
        line(waitStart("op-1", 2, 100)) +
        line(waitEnd("op-1", 3, 400)),
    );
    await drain();
    const before = await row("op-1");
    // Rewind the cursor to the start of the same file.
    await t.db
      .update(_opLogIngestCursor)
      .set({ offset: 0 })
      .where(eq(_opLogIngestCursor.source, OP_LOG_SOURCE));
    await drain();
    const after = await row("op-1");
    expect(after?.waits).toEqual(before!.waits);
    expect(after?.lastSeq).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a rotation between drains: finish .1, then the new live file", async () => {
    writeFileSync(
      path,
      line(requested("op-1")) + line(waitStart("op-1", 2, 100)),
    );
    await drain();
    appendFileSync(
      path,
      line(waitEnd("op-1", 3, 400)) + line(granted("op-1", 4, 500)),
    );
    renameSync(path, `${path}.1`); // the sink's rotation
    writeFileSync(
      path,
      line(completed("op-1", 5, 900)) + line(requested("op-2")),
    );
    expect(await drain()).toMatchObject({ kind: "ok", lines: 4, gap: false });
    const r = await row("op-1");
    expect(r).toMatchObject({
      closedBy: "self",
      outcome: "success",
      totalMs: 900,
      openWait: null,
    });
    expect(r?.grantedAt?.toISOString()).toBe(iso(500));
    expect(await row("op-2")).not.toBeNull();
    const cursor = await readCursor(t.db);
    expect(cursor?.offset).toBe(Bun.file(path).size);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the cursor's file rotated away: gap, and the live tail is read", async () => {
    writeFileSync(path, line(requested("op-1")));
    await drain();
    for (const n of [1, 2, 3, 4]) {
      renameSync(path, `${path}.${n}`);
      writeFileSync(path, line(requested(`op-r${n}`)));
    }
    rmSync(`${path}.4`); // dropped past `keep`
    rmSync(`${path}.3`);
    rmSync(`${path}.2`);
    rmSync(`${path}.1`);
    expect(await drain()).toMatchObject({ kind: "ok", gap: true });
    expect((await readCursor(t.db))?.gapAt).not.toBeNull();
    expect(await row("op-r4")).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the seed tail drops a clipped head line and stores no headless op", async () => {
    const head = line(requested("op-old"));
    writeFileSync(
      path,
      head + line(waitStart("op-old", 2, 100)) + line(requested("op-new")),
    );
    // A seed that starts mid-way through the `requested` line of op-old.
    const size = Bun.file(path).size;
    await drain(size - Math.floor(head.length / 2));
    expect(await row("op-old")).toBeNull(); // headless: only its wait-start seen
    expect(await row("op-new")).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a legacy snapshot line still folds", async () => {
    const legacy: OpLine = {
      phase: "completed",
      opId: "op-legacy",
      kind: "push",
      opSlug: "att-test",
      branch: "claude-web/att-test",
      requestedAt: iso(0),
      grantedAt: iso(10),
      completedAt: iso(50),
      waits: [{ kind: "push-mutex", startMs: 0, durationMs: 10 }],
      holdMs: 40,
      totalMs: 50,
      outcome: "success",
    };
    writeFileSync(path, line(legacy));
    await drain();
    expect(await row("op-legacy")).toMatchObject({
      kind: "push",
      closedBy: "self",
      pid: null,
      lastSeq: 0,
      closedWaitMs: 10,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sleep columns", () => {
  const HOUR = 3_600_000;
  const zz = (asleepMs: number, wakeAtMs?: number) =>
    wakeAtMs === undefined
      ? { boot: "boot-A", asleepMs }
      : { boot: "boot-A", asleepMs, wakeAtMs };

  test("stamped events round-trip sleeps and the last stamp", async () => {
    writeFileSync(
      path,
      line({ ...requested("op-nap"), sleep: zz(1_000) }) +
        line({
          ...waitStart("op-nap", 2, 100),
          at: iso(HOUR + 100),
          sleep: zz(1_000 + HOUR - 10_000, T0 + HOUR),
        }),
    );
    await drain();
    const r = await row("op-nap");
    expect(r?.sleeps).toEqual([
      { startMs: 10_000, durationMs: HOUR - 10_000, approx: false },
    ]);
    expect(r?.sleepStamp).toEqual({
      boot: "boot-A",
      asleepMs: 1_000 + HOUR - 10_000,
      atMs: T0 + HOUR + 100,
    });
    // …and back into the reducer, so the next line continues the fold.
    const state = opRowToFoldState(r!);
    expect(state.sleeps).toEqual(r!.sleeps);
    expect(state.sleepStamp).toEqual(r!.sleepStamp);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a row stored before the columns existed reads as no sleep", async () => {
    await t.db.execute(sql`
      INSERT INTO op_log_ops (op_id, kind, branch, requested_at, waits, steps)
      VALUES ('op-old', 'push', 'b', ${iso(0)}, '[]'::jsonb, '[]'::jsonb)
    `);
    const r = await row("op-old");
    expect(r?.sleeps).toEqual([]);
    expect(r?.sleepStamp).toBeNull();
    expect(opRowToFoldState(r!).sleeps).toEqual([]);
  });
});

describe("reconcileOps", () => {
  test("main appends a reconciler terminal for a dead op, which then ingests", async () => {
    writeFileSync(
      path,
      line(requested("op-dead")) +
        line(waitStart("op-dead", 2, 100)) +
        line(requested("op-alive")),
    );
    await drain();
    const appended: OpEvent[] = [];
    const r = await reconcileOps({
      db: t.db,
      main: true,
      isLive: async (op) => op.opId === "op-alive",
      append: (ev) => {
        appended.push(ev);
        appendFileSync(path, line(ev));
      },
      now: () => T0 + 5_000,
      sleepNow: () => ({ boot: "boot-A", asleepMs: 7, wakeAtMs: null }),
    });
    expect(r).toEqual({ appended: 1, closedLocally: 0 });
    expect(appended[0]).toMatchObject({
      opId: "op-dead",
      e: "completed",
      by: "reconciler",
      seq: 3,
      // The closing event carries the reconciler's own sleep reading.
      sleep: { boot: "boot-A", asleepMs: 7 },
    });
    await drain();
    expect(await row("op-dead")).toMatchObject({
      closedBy: "reconciler",
      interrupted: true,
      outcome: "error",
      openWait: null,
      completedAt: null,
    });
    expect((await row("op-alive"))?.closedBy).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a worktree closes nothing without a gap, and only pre-gap rows after one", async () => {
    writeFileSync(path, line(requested("op-before")));
    await drain();
    const deps = {
      db: t.db,
      main: false,
      isLive: async () => false,
      append: () => {
        throw new Error("a worktree never writes the shared log");
      },
    };
    expect(await reconcileOps(deps)).toEqual({ appended: 0, closedLocally: 0 });

    // A gap lands AFTER op-before was requested, BEFORE op-after.
    const gapAt = new Date(T0 + 1_000);
    await t.db
      .update(_opLogIngestCursor)
      .set({ gapAt })
      .where(eq(_opLogIngestCursor.source, OP_LOG_SOURCE));
    const after = { ...requested("op-after"), at: iso(2_000) };
    appendFileSync(path, line(after));
    await drain();

    expect(await reconcileOps(deps)).toEqual({ appended: 0, closedLocally: 1 });
    expect(await row("op-before")).toMatchObject({
      closedBy: "ingest-gap",
      interrupted: true,
      outcome: "error",
    });
    expect((await row("op-after"))?.closedBy).toBeNull();

    // A later line for a gap-closed op is ignored: a terminal wins.
    appendFileSync(path, line(waitStart("op-before", 2, 100)));
    await drain();
    expect((await row("op-before"))?.openWait).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
