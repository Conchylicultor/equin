import { describe, expect, test } from "bun:test";
import { pgTable, pgView, text } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb } from "../testing/recording-db";
import { compileLookup, type LookupRead } from "./compile-lookup";
import { compiledValueReach } from "./routes";

// `compileLookup`: one declaration → the tagged by-key statement (`run`) and
// what it reads (`read`) — routes gated by exactly the columns the SQL
// references, the key table matched per tuple — and `compiledValueReach`
// folding a lookup into a served value's plan, its tables tagged.

const convs = pgTable("lk_conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  status: text("status"),
});
const atts = pgTable("lk_attempts", {
  id: text("id").primaryKey(),
  worktreePath: text("worktree_path").notNull(),
  taskId: text("task_id"),
});
const notes = pgTable("lk_notes", { id: text("id").primaryKey() });

const attemptJoin = {
  kind: "lookup",
  alias: "attempt",
  table: atts,
  pk: atts.id,
  on: { from: "base", col: convs.attemptId },
  required: true,
} satisfies LookupJoin<"attempt", typeof atts>;

const Row = z.object({ attemptId: z.string(), path: z.string() });

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
 * trips await-thenable.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

// A label is a read tag, minted once per process: every compile names its own.
let compiles = 0;
const nextLabel = () => `test.ws-of-conv-${++compiles}`;

function lookup(script?: Parameters<typeof recordingQueryDb>[0]) {
  const rec = recordingQueryDb(script);
  const label = nextLabel();
  const compiled = compileLookup({
    label,
    from: convs,
    by: convs.id,
    joins: [attemptJoin],
    select: {
      attemptId: { from: "attempt", col: atts.id },
      path: { from: "attempt", col: atts.worktreePath },
    },
    row: Row,
    db: rec.db,
  });
  return { ...rec, compiled, label };
}

describe("compileLookup", () => {
  test("its routes: one full route per relation, gated by the columns the SQL reads, the key table matched", () => {
    const { compiled, label } = lookup();
    const read = compiled.read<{ conv: string }>((p) => p.conv);
    expect(read.label).toBe(label);
    expect(
      read.routes.map(({ id, table, map, columns, match }) => ({
        id,
        table,
        kind: map.kind,
        columns: [...columns].sort(),
        match,
      })),
    ).toEqual([
      {
        id: `${label}:lk_conversations`,
        table: "lk_conversations",
        kind: "full",
        // The key and the join key — never `status`, so a turn is gated out.
        columns: ["attempt_id", "id"],
        match: ["id"],
      },
      {
        id: `${label}:attempt`,
        table: "lk_attempts",
        kind: "full",
        columns: ["id", "worktree_path"],
        match: undefined,
      },
    ]);
  });

  test("each tuple reads its own key, and a tuple naming none reads nothing", () => {
    const { compiled, label } = lookup();
    const read = compiled.read<{ conv?: string }>((p) => p.conv ?? null);
    const uses = read.usesOf({ conv: "c1" });
    expect([...uses.keys()]).toEqual([
      `${label}:lk_conversations`,
      `${label}:attempt`,
    ]);
    expect(uses.get(`${label}:lk_conversations`)!.match).toEqual({
      id: new Set(["c1"]),
    });
    expect(uses.get(`${label}:attempt`)!.match).toBeUndefined();
    expect(read.usesOf({}).size).toBe(0);
  });

  test("run: one statement carrying the read tag, the key bound as a parameter; found / not found", async () => {
    const { compiled, calls, label } = lookup((q) =>
      JSON.stringify(q.params).includes('"c1"')
        ? [{ attemptId: "a1", path: "/wt/a1" }]
        : [],
    );
    expect(await compiled.run("c1")).toEqual({
      found: true,
      row: { attemptId: "a1", path: "/wt/a1" },
    });
    expect(await compiled.run("c2")).toEqual({ found: false });
    expect(await compiled.run(null)).toEqual({ found: false });
    expect(calls).toHaveLength(2);
    const [first] = calls;
    expect(first!.sql).toContain(`/* read-tag:${label} */`);
    expect(first!.sql).toContain('inner join "lk_attempts" "attempt"');
    expect(first!.sql).not.toContain("c1");
  });

  test("run refuses a row its schema does not hold, and more than one row", async () => {
    const bad = lookup(() => [{ attemptId: "a1", path: 3 }]);
    await rejection(bad.compiled.run("c1"));
    const many = lookup(() => [
      { attemptId: "a1", path: "/a" },
      { attemptId: "a2", path: "/b" },
    ]);
    expect((await rejection(many.compiled.run("c1"))).message).toMatch(
      /2 rows for key "c1"/,
    );
  });

  test("refused at compile: a view, a key that is not the primary key, a bad label, a column of an undeclared relation", () => {
    const base = {
      label: "test.x",
      from: convs,
      by: convs.id,
      select: { id: { from: "base", col: convs.id } },
      row: z.object({ id: z.string() }),
      db: recordingQueryDb().db,
    };
    const view = pgView("lk_conversations_v").as((qb) =>
      qb.select().from(convs),
    );
    expect(() =>
      compileLookup({ ...base, from: view as unknown as typeof convs }),
    ).toThrow(/never a view/);
    expect(() => compileLookup({ ...base, by: convs.attemptId })).toThrow(
      /not the single-column primary key/,
    );
    expect(() => compileLookup({ ...base, label: "has space" })).toThrow(
      /no read tag/,
    );
    // None of the refused compiles claimed the label: it still compiles once,
    // and a second compile under it is refused.
    compileLookup(base);
    expect(() => compileLookup(base)).toThrow(/already minted/);
    expect(() =>
      compileLookup({
        ...base,
        select: { path: { from: "attempt", col: atts.worktreePath } },
      }),
    ).toThrow();
  });
});

describe("compiledValueReach — lookups", () => {
  const read = (): LookupRead<{ conv: string }> =>
    lookup().compiled.read<{ conv: string }>((p) => p.conv);

  test("a lookup's routes join the plan, its tables tagged, its uses per tuple beside the whole tables'", () => {
    const lk = read();
    const plan = compiledValueReach(
      { tables: [notes], lookups: [lk], reason: "r" },
      "v",
    );
    expect(plan.routes.map((r) => r.id)).toEqual([
      "lk_notes",
      `${lk.label}:lk_conversations`,
      `${lk.label}:attempt`,
    ]);
    expect(plan.taggedReads).toEqual([
      { table: "lk_conversations", tag: lk.label },
      { table: "lk_attempts", tag: lk.label },
    ]);
    const uses = plan.usesOf({ conv: "c1" });
    expect([...uses.keys()]).toEqual(plan.routes.map((r) => r.id));
    expect(uses.get(`${lk.label}:lk_conversations`)!.match).toEqual({
      id: new Set(["c1"]),
    });
  });

  test("no lookup: no tagged reads, the shape a whole-table plan always had", () => {
    expect(
      compiledValueReach({ tables: [notes], reason: "r" }, "v").taggedReads,
    ).toBeUndefined();
  });

  test("refuses a table read whole and through a lookup, a lookup twice, and a read no compile minted", () => {
    expect(() =>
      compiledValueReach(
        { tables: [convs], lookups: [read()], reason: "r" },
        "v",
      ),
    ).toThrow(/read whole \(`tables`\) and through the lookup/);
    const twice = read();
    expect(() =>
      compiledValueReach(
        { tables: [], lookups: [twice, twice], reason: "r" },
        "v",
      ),
    ).toThrow(new RegExp(`lists "${twice.label}" twice`));
    const forged = { ...read() } as Record<string | symbol, unknown>;
    for (const s of Object.getOwnPropertySymbols(forged)) delete forged[s];
    expect(() =>
      compiledValueReach(
        {
          tables: [],
          lookups: [forged as unknown as LookupRead<{ conv: string }>],
          reason: "r",
        },
        "v",
      ),
    ).toThrow(/did not mint/);
  });
});
