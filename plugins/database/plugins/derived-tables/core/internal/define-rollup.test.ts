import { describe, expect, test } from "bun:test";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  ATTEMPT_CONV_AGG_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import { defineRollup } from "./define-rollup";

// The eval-time contract of `defineRollup` and the shape of what it generates.
// The SQL itself is exercised against a real database in
// plugins/database/plugins/migrations/check/internal/rollup-oracle.test.ts.

const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  status: text("status").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  waitingFor: text("waiting_for"),
});
const attempts = pgTable("attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  n: integer("n"),
});
const agg = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
  maxEndedAt: timestamp("max_ended_at", { withTimezone: true }),
});
const latest = pgTable(TASK_LATEST_CONVERSATION_TABLE, {
  taskId: text("task_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
});

const aggSelect = (scope: (k: string) => string) =>
  `SELECT c.attempt_id, true AS has_conv, max(c.ended_at) AS max_ended_at
     FROM conversations c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`;

function convAgg(over: Partial<Parameters<typeof defineRollup>[0]> = {}) {
  return defineRollup({
    table: agg,
    key: agg.attemptId,
    select: aggSelect,
    sources: [
      {
        table: conversations,
        carry: conversations.attemptId,
        reads: [conversations.endedAt],
      },
    ],
    ...over,
  });
}

describe("defineRollup — what it generates", () => {
  test("one maintain function and <rollup>__<source>_{i,u,d} triggers per source", () => {
    const r = convAgg();
    expect(r.table).toBe("attempt_conv_agg");
    expect(r.key).toBe("attempt_id");
    expect(r.columns.map((c) => c.name)).toEqual([
      "attempt_id",
      "has_conv",
      "max_ended_at",
    ]);
    const [s] = r.sources;
    expect(s!.functionName).toBe("attempt_conv_agg__conversations_maintain");
    expect(s!.triggers.map((t) => t.name)).toEqual([
      "attempt_conv_agg__conversations_i",
      "attempt_conv_agg__conversations_u",
      "attempt_conv_agg__conversations_d",
    ]);
  });

  test("C1: the UPDATE trigger has no column list, and the function diffs carry + reads over the pk join", () => {
    const [s] = convAgg().sources;
    const update = s!.triggers.find((t) => t.op === "update")!;
    expect(update.ddl).toMatch(/AFTER UPDATE ON "public"\."conversations"\n/);
    expect(update.ddl).not.toMatch(/UPDATE OF/);
    expect(s!.functionDdl).toContain(
      `FULL JOIN new_rows AS n ON o."id" = n."id"`,
    );
    expect(s!.functionDdl).toContain(
      `ROW(o."attempt_id", o."ended_at") IS DISTINCT FROM ROW(n."attempt_id", n."ended_at")`,
    );
    // waiting_for is not read, so it is not diffed.
    expect(s!.functionDdl).not.toContain("waiting_for");
  });

  test("A34: per-key advisory locks in sorted order, before the aggregate", () => {
    const fn = convAgg().sources[0]!.functionDdl;
    const lock = fn.indexOf("pg_advisory_xact_lock");
    expect(lock).toBeGreaterThan(fn.indexOf("ORDER BY x"));
    expect(lock).toBeLessThan(fn.indexOf("WITH _rollup_agg"));
  });

  test("A34: the reconcile locks each drifted key as a maintain does, in order", () => {
    const r = convAgg();
    expect(r.sources[0]!.functionDdl).toContain(
      `hashtextextended('attempt_conv_agg:' || _rollup_key::text, 0)`,
    );
    const lock = r.lockSql(["a", "o'k"]);
    expect(lock).toContain(`hashtextextended('attempt_conv_agg:' || e.k, 0)`);
    expect(lock).toContain(`'["a","o''k"]'::jsonb`);
    expect(lock).toContain("ORDER BY e.i");
    // The write is scoped to the drifted keys, never the whole table.
    expect(r.reconcileSql(["a"])).toContain(
      `"attempt_id" = ANY(ARRAY(SELECT e.k::text FROM jsonb_array_elements_text('["a"]'::jsonb) AS e(k)))`,
    );
  });

  test("the select check keeps the key expression without filtering", () => {
    expect(convAgg().selectCheckSql).toContain(
      "WHERE ((c.attempt_id) IS NULL OR true)",
    );
  });

  test("the upsert writes only a changed row", () => {
    const fn = convAgg().sources[0]!.functionDdl;
    expect(fn).toContain(
      `WHERE ROW(t."has_conv", t."max_ended_at") IS DISTINCT FROM ROW(EXCLUDED."has_conv", EXCLUDED."max_ended_at")`,
    );
  });

  test("a via hop resolves keys through the hop table; ops narrow the triggers", () => {
    const r = defineRollup({
      table: latest,
      key: latest.taskId,
      select: (scope) =>
        `SELECT DISTINCT ON (a.task_id) a.task_id, c.id AS conversation_id
           FROM conversations c JOIN attempts a ON a.id = c.attempt_id
          WHERE ${scope("a.task_id")} ORDER BY a.task_id, c.id`,
      sources: [
        {
          table: conversations,
          carry: conversations.attemptId,
          via: { table: attempts, match: attempts.id, key: attempts.taskId },
          reads: [],
        },
        {
          table: attempts,
          carry: attempts.taskId,
          reads: [],
          ops: ["update", "delete"],
        },
      ],
    });
    expect(r.sources[0]!.functionDdl).toContain(
      `FROM "public"."attempts" AS v`,
    );
    expect(r.sources[1]!.triggers.map((t) => t.op)).toEqual([
      "update",
      "delete",
    ]);
  });
});

describe("defineRollup — eval-time refusals", () => {
  test("C11: a table that is not an IMPERATIVE_PUBLIC_TABLES value", () => {
    const rogue = pgTable("rogue_rollup", { id: text("id").primaryKey() });
    expect(() =>
      defineRollup({
        table: rogue,
        key: rogue.id,
        select: (scope) => `SELECT id FROM x WHERE ${scope("id")}`,
        sources: [
          { table: conversations, carry: conversations.attemptId, reads: [] },
        ],
      }),
    ).toThrow(/not an imperative public table/);
  });

  test("a read column of another table", () => {
    expect(() =>
      convAgg({
        sources: [
          {
            table: conversations,
            carry: conversations.attemptId,
            reads: [attempts.n],
          },
        ],
      }),
    ).toThrow(/reads\[0\] is column "n" of "attempts", not of "conversations"/);
  });

  test("a carry whose type is not the key's, with no via", () => {
    const ints = pgTable("ints", { id: integer("id").primaryKey() });
    expect(() =>
      convAgg({ sources: [{ table: ints, carry: ints.id, reads: [] }] }),
    ).toThrow(/carry "id" is integer but the rollup key is text/);
  });

  test("a key that is not the table's primary key", () => {
    expect(() => convAgg({ key: agg.hasConv })).toThrow(
      /must be the table's only primary-key column/,
    );
  });

  test("two sources on one table", () => {
    const s = {
      table: conversations,
      carry: conversations.attemptId,
      reads: [],
    };
    expect(() => convAgg({ sources: [s, s] })).toThrow(
      /two sources on "conversations"/,
    );
  });

  test("a select that never calls scope", () => {
    expect(() => convAgg({ select: () => `SELECT 1 AS attempt_id` })).toThrow(
      /select must call scope/,
    );
  });
});
