import { describe, expect, test } from "bun:test";
import { setErrorReporter } from "@plugins/framework/plugins/server-core/core";
import type { QueryDeadlineEvent } from "@plugins/database/plugins/connection/server";
import type { recordReport } from "@plugins/reports/plugins/engine/server";
import type { TraceTrigger } from "@plugins/debug/plugins/trace/plugins/engine/core";
import {
  DbAbandonCapPayloadSchema,
  DbQueryDeadlinePayloadSchema,
  QUERY_DEADLINE_RING_CAPACITY,
} from "../../core";
import { QueryDeadlinesSchema } from "../../core/internal/resources";
import { createQueryDeadlineHandler } from "./handler";
import { createHitRing } from "./hit-ring";
import { abandonCapFingerprint, queryDeadlineFingerprint } from "./render";

type ReportInput = Parameters<typeof recordReport>[0];

function harness(opts: { traceAdmits?: () => boolean } = {}) {
  const calls: string[] = [];
  const recorded: ReportInput[] = [];
  const logged: string[] = [];
  const triggers: TraceTrigger[] = [];
  const ring = createHitRing(QUERY_DEADLINE_RING_CAPACITY);
  const admits = opts.traceAdmits ?? (() => true);
  const handle = createQueryDeadlineHandler({
    captureTrace: (trigger) => {
      calls.push("trace");
      triggers.push(trigger);
      return admits() ? { id: `trace-${triggers.length}` } : null;
    },
    recordReport: (input) => {
      calls.push("record");
      recorded.push(input);
      return Promise.resolve({
        outcome: "recorded",
        reportId: "r1",
        taskId: null,
        rateLimited: false,
      });
    },
    ring,
    notify: () => {
      calls.push("notify");
    },
    log: (line) => {
      calls.push("log");
      logged.push(line);
    },
  });
  return { calls, recorded, logged, triggers, ring, handle };
}

const deadline: QueryDeadlineEvent = {
  kind: "deadline",
  at: 1_789_120_000_000,
  sql: "select count(*) from conversations_v",
  elapsedMs: 60_004,
  deadlineMs: 60_000,
  origin: "push conversations-gone-stats",
  pool: "app",
  phase: "query",
  reason: null,
  transaction: "open",
  inFlight: [
    {
      pool: "app",
      phase: "query",
      sql: "insert into conversations_ext_usage values ($1)",
      origin: "conversations.usage:sync",
      ageMs: 45_000,
      transaction: "open",
    },
  ],
  inFlightCount: 1,
  abandoned: { total: 2, held: 2, inTransaction: 1 },
};

const fingerprintOf = (input: ReportInput): string =>
  queryDeadlineFingerprint(DbQueryDeadlinePayloadSchema.parse(input.data));

describe("deadline event", () => {
  test("files one db-query-deadline report whose payload the kind accepts", () => {
    const h = harness();
    h.handle(deadline);

    expect(h.recorded).toHaveLength(1);
    const input = h.recorded[0]!;
    expect(input.kind).toBe("db-query-deadline");
    expect(input.source).toBe("server-caught");
    expect(input.message).toBe(
      "A database query (pool app) got no answer for 60s and was abandoned: select count(*) from conversations_v",
    );
    // The payload is exactly what the kind's schema validates on ingest — no
    // `at` (the row has its own first/last-seen), nothing dropped.
    expect(DbQueryDeadlinePayloadSchema.parse(input.data)).toEqual({
      sql: deadline.sql,
      elapsedMs: 60_004,
      deadlineMs: 60_000,
      origin: "push conversations-gone-stats",
      pool: "app",
      phase: "query",
      reason: null,
      transaction: "open",
      inFlight: deadline.kind === "deadline" ? deadline.inFlight : [],
      inFlightCount: 1,
      abandoned: { total: 2, held: 2, inTransaction: 1 },
      traceId: "trace-1",
    });
  });

  test("captures one critical trace of the instant, labelled by connection, and links it", () => {
    const h = harness();
    h.handle(deadline);
    expect(h.triggers).toEqual([
      {
        kind: "db-query-deadline",
        label: "app:query",
        durationMs: 60_004,
        thresholdMs: 60_000,
        critical: true,
        detail: expect.objectContaining({
          sql: deadline.sql,
          transaction: "open",
          inFlightCount: 1,
        }),
      },
    ]);
  });

  test("a miss inside the trace cooldown keeps the label's latest trace link", () => {
    let admit = true;
    const h = harness({ traceAdmits: () => admit });
    h.handle(deadline);
    admit = false;
    h.handle({ ...deadline, at: deadline.at + 1, origin: "other caller" });
    // Another connection has no trace of its own to link.
    h.handle({ ...deadline, pool: "jobs-runner" });
    // A miss long after the traced instant (tracing off, say) links nothing:
    // that trace says nothing about this call's wait.
    h.handle({ ...deadline, at: deadline.at + 10 * 60_000 });
    expect(
      h.recorded.map((r) => DbQueryDeadlinePayloadSchema.parse(r.data).traceId),
    ).toEqual(["trace-1", "trace-1", null, null]);
  });

  test("a trace capture that throws is reported, and the report still files", () => {
    const errors: string[] = [];
    setErrorReporter((e) => errors.push(e.message));
    try {
      const h = harness({
        traceAdmits: () => {
          throw new Error("trace class blew up");
        },
      });
      h.handle(deadline);
      expect(h.recorded).toHaveLength(1);
      expect(
        DbQueryDeadlinePayloadSchema.parse(h.recorded[0]!.data).traceId,
      ).toBeNull();
      expect(errors).toEqual([
        "[db] query-deadline: capturing the trace of a lost call failed: trace class blew up",
      ]);
    } finally {
      setErrorReporter(() => {});
    }
  });

  test("fingerprints on pool, phase and caller — the label only without one", () => {
    const h = harness();
    h.handle(deadline);
    // Same caller, another statement (an `in (…)` list of another arity, the
    // next statement of its transaction): the same row.
    h.handle({
      ...deadline,
      at: deadline.at + 1,
      elapsedMs: 61_000,
      sql: "select 1",
    });
    // Same caller on another pool: its own row.
    h.handle({ ...deadline, pool: "jobs-enqueue" });
    // Another caller: its own row.
    h.handle({ ...deadline, origin: "other" });
    // No caller (boot, migrations): keyed by the statement instead.
    h.handle({ ...deadline, origin: null });
    h.handle({ ...deadline, origin: null, sql: "select 1" });
    // A connect from the same caller is a different fact from its query.
    h.handle({ ...deadline, phase: "connect", sql: "[connect]" });

    expect(h.recorded.map(fingerprintOf)).toEqual([
      "db-query-deadline:app:query:origin=push conversations-gone-stats",
      "db-query-deadline:app:query:origin=push conversations-gone-stats",
      "db-query-deadline:jobs-enqueue:query:origin=push conversations-gone-stats",
      "db-query-deadline:app:query:origin=other",
      "db-query-deadline:app:query:sql=select count(*) from conversations_v",
      "db-query-deadline:app:query:sql=select 1",
      "db-query-deadline:app:connect:origin=push conversations-gone-stats",
    ]);
  });

  test("a connect reads as opening a connection, with no query", () => {
    const h = harness();
    h.handle({
      ...deadline,
      pool: "jobs-runner",
      phase: "connect",
      sql: "[connect]",
    });
    expect(h.recorded[0]!.message).toBe(
      "Opening a database connection (pool jobs-runner) got no answer for 60s and was abandoned",
    );
  });

  test("a row filed before pools existed still parses, as an app-pool query", () => {
    const legacy = {
      sql: "select 1",
      elapsedMs: 60_004,
      deadlineMs: 60_000,
      origin: null,
      reason: null,
      leased: true,
    };
    const parsed = DbQueryDeadlinePayloadSchema.parse(legacy);
    expect(parsed).toEqual({
      sql: "select 1",
      elapsedMs: 60_004,
      deadlineMs: 60_000,
      origin: null,
      pool: "app",
      phase: "query",
      reason: null,
      // Not recorded then — never a value claiming "nothing was waiting".
      transaction: null,
      inFlight: [],
      inFlightCount: null,
      abandoned: null,
      traceId: null,
    });
    expect(queryDeadlineFingerprint(parsed)).toBe(
      "db-query-deadline:app:query:sql=select 1",
    );
    expect(
      DbAbandonCapPayloadSchema.parse({ abandoned: 33, cap: 32 }).pool,
    ).toBe("app");
  });

  test("records the hit in the ring and pushes it BEFORE the report write", () => {
    const h = harness();
    h.handle(deadline);

    expect(h.ring.snapshot()).toEqual([
      {
        at: deadline.at,
        pool: "app",
        phase: "query",
        sql: deadline.sql,
        origin: "push conversations-gone-stats",
        elapsedMs: 60_004,
      },
    ]);
    expect(QueryDeadlinesSchema.parse({ hits: h.ring.snapshot() })).toEqual({
      hits: h.ring.snapshot(),
    });
    // The log line and the row must land even when the report write is what
    // cannot reach the DB.
    expect(h.calls).toEqual(["log", "notify", "trace", "record"]);
  });

  test("writes the durable [deadline] line naming pool, phase, caller and bound", () => {
    const h = harness();
    h.handle({ ...deadline, pool: "jobs-enqueue", reason: "boot: migrations" });
    expect(h.logged).toEqual([
      "[deadline] pool=jobs-enqueue phase=query no reply in 60004ms " +
        "(bound 60000ms, boot: migrations) origin=push conversations-gone-stats " +
        "sql=select count(*) from conversations_v — connection abandoned",
    ]);
  });
});

describe("abandon-cap event", () => {
  test("files one rolling db-abandon-cap report and leaves the ring alone", () => {
    const h = harness();
    h.handle({
      kind: "abandon-cap",
      at: 1,
      pool: "change-feed",
      abandoned: 33,
      cap: 32,
    });

    expect(h.recorded).toHaveLength(1);
    const input = h.recorded[0]!;
    expect(input.kind).toBe("db-abandon-cap");
    expect(input.source).toBe("server-caught");
    expect(input.message).toBe(
      "33 database connections have been abandoned since the server started — more than the 32 it is built to hold (latest: pool change-feed)",
    );
    expect(DbAbandonCapPayloadSchema.parse(input.data)).toEqual({
      pool: "change-feed",
      abandoned: 33,
      cap: 32,
    });
    expect(abandonCapFingerprint()).toBe("db-abandon-cap");
    expect(h.ring.snapshot()).toEqual([]);
    expect(h.calls).toEqual(["record"]);
  });
});

describe("hit ring", () => {
  test("keeps only the last 20 hits, oldest first", () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.handle({ ...deadline, at: i });

    const hits = h.ring.snapshot();
    expect(hits).toHaveLength(20);
    expect(hits[0]!.at).toBe(5);
    expect(hits.at(-1)!.at).toBe(24);
    // Every hit pushes, whether or not it evicted one.
    expect(h.calls.filter((c) => c === "notify")).toHaveLength(25);
  });

  test("the ring's bound is the resource schema's bound", () => {
    const hit = {
      at: 0,
      pool: "app" as const,
      phase: "query" as const,
      sql: "select 1",
      origin: null,
      elapsedMs: 1,
    };
    const full = Array.from(
      { length: QUERY_DEADLINE_RING_CAPACITY },
      () => hit,
    );
    expect(QueryDeadlinesSchema.safeParse({ hits: full }).success).toBe(true);
    expect(
      QueryDeadlinesSchema.safeParse({ hits: [...full, hit] }).success,
    ).toBe(false);
  });

  test("snapshot is a copy the loader can hand off", () => {
    const ring = createHitRing(2);
    const hit = {
      pool: "app" as const,
      phase: "query" as const,
      origin: null,
      elapsedMs: 1,
    };
    ring.push({ ...hit, at: 1, sql: "a" });
    const snap = ring.snapshot();
    ring.push({ ...hit, at: 2, sql: "b" });
    expect(snap).toHaveLength(1);
  });

  test("refuses a capacity that could not hold a hit", () => {
    expect(() => createHitRing(0)).toThrow(/positive integer/);
    expect(() => createHitRing(1.5)).toThrow(/positive integer/);
  });
});
