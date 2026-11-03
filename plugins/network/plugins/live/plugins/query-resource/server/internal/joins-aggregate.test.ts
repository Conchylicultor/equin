/**
 * The `aggregate` read expression (`JoinPlan.renderAggregate`, C7 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md): a grouped value
 * whose SQL names a CTE output, so no column walk could see what it reads. Its
 * provenance is declared, and every walk descends into it — so the routes and
 * gates a raw shape derives from `columnsIn` cover what the aggregate is
 * computed from, and an aggregate that declares nothing routable is refused
 * at compile (the silent-staleness risk).
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { integer, PgDialect, pgTable, text } from "drizzle-orm/pg-core";
import {
  BASE_RELATION,
  expr,
  type ColumnRef,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { compileJoins } from "./joins";
import { decoderOfRead } from "./raw-sql";

const tasks = pgTable("ag_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id"),
});
const owners = pgTable("ag_owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rank: integer("rank"),
});
const elsewhere = pgTable("ag_elsewhere", {
  id: text("id").primaryKey(),
});

const plan = () =>
  compileJoins(
    { table: tasks, name: "ag_tasks" },
    [
      {
        kind: "lookup",
        alias: "owner",
        table: owners,
        pk: owners.id,
        on: { from: BASE_RELATION, col: tasks.ownerId },
        required: false,
      },
    ],
    tasks.id,
    "ag",
  );

const ref = (from: string, col: ColumnRef["col"]): ColumnRef => ({ from, col });

describe("renderAggregate", () => {
  test("walks its declared reads, never its SQL", () => {
    const p = plan();
    const rank = p.render(ref("owner", owners.rank));
    const agg = p.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [rank, p.render(ref(BASE_RELATION, tasks.ownerId))],
      nullable: true,
      sqlType: "integer",
      decoder: Number,
    });
    expect(p.columnsIn(agg)).toEqual([
      ["owner", "rank"],
      [BASE_RELATION, "owner_id"],
    ]);
    expect([...p.relationsIn(agg)].sort()).toEqual([BASE_RELATION, "owner"]);
    // Its SQL is what the shape runs, parenthesised and decoded.
    expect(new PgDialect().sqlToQuery(agg).sql).toBe(`("__agg"."n")`);
    expect(decoderOfRead(agg).mapFromDriverValue("3")).toBe(3);
  });

  test("answers like an expression: name, type — and no one column", () => {
    const p = plan();
    const agg = p.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [p.render(ref("owner", owners.rank))],
      nullable: false,
      sqlType: "integer",
      decoder: Number,
    });
    expect(p.nameOf(agg)).toBe("ownerRank");
    expect(p.sqlTypeOf(agg)).toBe("integer");
    expect(p.isComputed(agg)).toBe(true);
    expect(p.memberOf(agg)).toBeUndefined();
    expect(p.relationKey(agg)).toBe("aggregate:ownerRank");
    expect(() => p.columnOf(agg)).toThrow(
      /aggregate "ownerRank" \(of relation "owner"\) reads no single column/,
    );
    expect(() => p.relationOf(agg)).toThrow(/reads no single column/);
  });

  test("nullability: its declared one, or NULL through a LEFT join over its relation", () => {
    const p = plan();
    const reads = [p.render(ref("owner", owners.rank))];
    const opts = { reads, sqlType: "integer", decoder: Number };
    // On the base relation (no LEFT join above it): the declaration stands.
    const onBase = (nullable: boolean) =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...opts,
        name: `base${nullable}`,
        relation: BASE_RELATION,
        nullable,
      });
    expect(p.canBeNull(onBase(false))).toBe(false);
    expect(p.canBeNull(onBase(true))).toBe(true);
    // On the LEFT lookup "owner": a host with no owner row reads it NULL,
    // whatever it declares.
    const onOwner = p.renderAggregate(sql`"__agg"."n"`, {
      ...opts,
      name: "ownerRank",
      relation: "owner",
      nullable: false,
    });
    expect(p.canBeNull(onOwner)).toBe(true);
    // Through an INNER join the declaration stands again.
    const inner = compileJoins(
      { table: tasks, name: "ag_tasks" },
      [
        {
          kind: "lookup",
          alias: "owner",
          table: owners,
          pk: owners.id,
          on: { from: BASE_RELATION, col: tasks.ownerId },
          required: true,
        },
      ],
      tasks.id,
      "ag",
    );
    const onInner = inner.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [inner.render(ref("owner", owners.rank))],
      nullable: false,
      sqlType: "integer",
      decoder: Number,
    });
    expect(inner.canBeNull(onInner)).toBe(false);
  });

  test("an expression over an aggregate reads the aggregate's provenance", () => {
    const p = plan();
    const agg = p.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [p.render(ref("owner", owners.rank))],
      nullable: true,
      sqlType: "integer",
      decoder: Number,
    });
    const field = expr(sql`coalesce(${agg}, 0) + 1`, {
      decoder: Number,
      sqlType: "integer",
      notNull: true,
    });
    const rendered = p.renderExpr(field, {
      name: "rankPlusOne",
      baseColumns: {},
    });
    expect(p.columnsIn(rendered)).toEqual([["owner", "rank"]]);
  });

  test("another plan recognises it by identity (module-level registry)", () => {
    const p = plan();
    const agg = p.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [p.render(ref("owner", owners.rank))],
      nullable: true,
      sqlType: "integer",
      decoder: Number,
    });
    const q = plan();
    expect(q.nameOf(agg)).toBe("ownerRank");
  });

  test("canBeNull on another plan's aggregate over a relation this plan lacks throws, naming it", () => {
    const p = plan();
    const agg = p.renderAggregate(sql`"__agg"."n"`, {
      name: "ownerRank",
      relation: "owner",
      reads: [p.render(ref("owner", owners.rank))],
      nullable: false,
      sqlType: "integer",
      decoder: Number,
    });
    const bare = compileJoins(
      { table: tasks, name: "ag_tasks" },
      [],
      tasks.id,
      "ag",
    );
    expect(() => bare.canBeNull(agg)).toThrow(
      /aggregate "ownerRank" belongs to relation "owner", which is neither the base nor a declared join/,
    );
  });

  test("rendered once per (relation, name): the same object back, a disagreeing re-registration refused", () => {
    const p = plan();
    const rank = p.render(ref("owner", owners.rank));
    const opts = {
      name: "ownerRank",
      relation: "owner",
      reads: [rank],
      nullable: true,
      sqlType: "integer",
      decoder: Number,
    };
    const first = p.renderAggregate(sql`"__agg"."n"`, opts);
    // A fresh fragment and options object, equal in substance: same identity.
    expect(
      p.renderAggregate(sql`"__agg"."n"`, { ...opts, reads: [rank] }),
    ).toBe(first);
    // The same name on another relation is another aggregate.
    expect(
      p.renderAggregate(sql`"__agg"."n"`, {
        ...opts,
        relation: BASE_RELATION,
      }),
    ).not.toBe(first);
    const refused =
      /aggregate "ownerRank" \(of relation "owner"\) is re-registered with a different/;
    expect(() => p.renderAggregate(sql`"__agg"."m"`, opts)).toThrow(refused);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, { ...opts, nullable: false }),
    ).toThrow(refused);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, { ...opts, sqlType: "bigint" }),
    ).toThrow(refused);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, { ...opts, decoder: String }),
    ).toThrow(refused);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...opts,
        reads: [rank, p.render(ref(BASE_RELATION, tasks.ownerId))],
      }),
    ).toThrow(refused);
    // Another plan renders its own.
    expect(plan().renderAggregate(sql`"__agg"."n"`, opts)).not.toBe(first);
  });

  test("refuses reads no route could reach, and undeclared relations", () => {
    const p = plan();
    const base = {
      name: "x",
      nullable: true,
      sqlType: "integer",
      decoder: Number,
    };
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...base,
        relation: "owner",
        reads: [],
      }),
    ).toThrow(/resolve to no relation column — no route would reach it/);
    // Raw text carries no column objects: still nothing routable.
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...base,
        relation: "owner",
        reads: [sql.raw(`"owner"."rank"`)],
      }),
    ).toThrow(/resolve to no relation column/);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...base,
        relation: "nope",
        reads: [p.render(ref("owner", owners.rank))],
      }),
    ).toThrow(
      /belongs to relation "nope", which is neither the base nor a declared join/,
    );
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...base,
        relation: "owner",
        reads: [elsewhere.id],
      }),
    ).toThrow(/reads table "ag_elsewhere"|reads relation "ag_elsewhere"/);
    expect(() =>
      p.renderAggregate(sql`"__agg"."n"`, {
        ...base,
        sqlType: "integer; drop",
        relation: "owner",
        reads: [p.render(ref("owner", owners.rank))],
      }),
    ).toThrow(/not a Postgres type name/);
  });

  test("an unregistered SQL read still throws", () => {
    const p = plan();
    expect(() => p.nameOf(sql`"__agg"."n"`)).toThrow(
      /render a ColumnRef \(or an ExprField, or an aggregate\)/,
    );
  });
});
