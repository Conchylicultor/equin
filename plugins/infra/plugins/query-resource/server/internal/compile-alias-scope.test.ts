/**
 * The `all` compiler's SCOPE (`all: { by }`, track item [12] §A of
 * research/2026-10-19-global-live-compiled-narrowing.md): one tuple per
 * scope, compiled against the recording `QueryDb`.
 *
 * Pinned here: the one loop over `by` — every shape's SQL reads `col =
 * $param` for exactly the tuple's params (the full, scoped and orderIds
 * shapes; never `:rows`, which stays global), the base identity route
 * declares that column as its `match`, and each tuple's base use matches it
 * on exactly that param (and moves on it) — so the match the router filters
 * by IS the SQL's predicate; the server's params gate (canonical text per
 * column type); the definition (computed over a placeholder scope, moved by
 * the scope); an unscoped compile keeping its exact shape (no `match`); and
 * every refusal (a non-base field, a type whose text is not canonical, a
 * field not projected). The DB-backed oracle over the real feed is
 * network/live's `serve-collection-all-scoped-oracle.test.ts`.
 *
 * Run: `./singularity test plugins/infra/plugins/query-resource`.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import type { RoutePlan } from "@plugins/framework/plugins/resource-runtime/core";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import {
  BASE_RELATION,
  expr,
  type AllQueryResourceContract,
  type LookupJoin,
  type PointQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb, type RecordedQuery } from "../testing/recording-db";
import { compileAllCollection, type AllCollectionSpec } from "./compile-alias";

// ── The schema ───────────────────────────────────────────────────────────────

const pages = pgTable("s_pages", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const blocks = pgTable("s_blocks", {
  id: text("id").primaryKey(),
  pageId: uuid("page_id").notNull(),
  ownerKey: text("owner_key").notNull(),
  seq: integer("seq").notNull(),
  big: bigint("big", { mode: "number" }).notNull(),
  rank: text("rank").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  weight: doublePrecision("weight"),
  pageRef: text("page_ref").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  data: text("data"),
  status: parsedText("status", z.enum(["open", "done"])).notNull(),
});

const page: LookupJoin<"page", typeof pages> = {
  kind: "lookup",
  alias: "page",
  table: pages,
  pk: pages.id,
  on: { from: BASE_RELATION, col: blocks.pageRef },
  required: false,
};
const JOINS = [page] as const;

interface Row {
  id: string;
}

const ORDER: readonly (readonly [string, "asc" | "desc"])[] = [
  ["rank", "asc"],
  ["createdAt", "asc"],
];

/** The two contracts — scoped by `by` when it is non-empty, the descriptor's gate a recorder. */
function contracts(key: string, by: readonly string[]) {
  const gated: Record<string, string>[] = [];
  const all = {
    key,
    schema: z.array(z.object({ id: z.string() }).passthrough()),
    keyed: { keyOf: (r: unknown) => (r as Row).id },
    all: {
      orderBy: ORDER,
      unbounded: { reason: "a test set" },
      ...(by.length === 0 ? {} : { by }),
    },
    queryPk: "id",
    validateParams: (p: Record<string, string>) => void gated.push(p),
  } as unknown as AllQueryResourceContract<Row, string>;
  const rows = {
    key: `${key}:rows`,
    queryPk: "id",
    point: {
      decode: (p: Record<string, string>) =>
        p.ids === "" || p.ids === undefined ? [] : p.ids!.split(","),
      encode: (ids: readonly string[]) => ({ ids: [...ids].sort().join(",") }),
    },
  } as unknown as PointQueryResourceContract<Row>;
  return { all, rows, gated };
}

function spec(
  overrides: Partial<AllCollectionSpec<typeof blocks, typeof JOINS>> = {},
): AllCollectionSpec<typeof blocks, typeof JOINS> {
  return {
    from: blocks,
    joins: JOINS,
    select: ({ j, render, expr: ex }) => ({
      id: render(j.base.id),
      pageId: render(j.base.pageId),
      ownerKey: render(j.base.ownerKey),
      seq: render(j.base.seq),
      big: render(j.base.big),
      rank: render(j.base.rank),
      createdAt: render(j.base.createdAt),
      weight: render(j.base.weight),
      data: render(j.base.data),
      pageTitle: render(j.page.title),
      label: ex(
        expr(sql`upper(${j.base.ownerKey})`, {
          decoder: String,
          sqlType: "text",
          notNull: true,
        }),
        "label",
      ),
    }),
    where: sql`${blocks.deletedAt} IS NULL`,
    ...overrides,
  };
}

const PAGE_A = "0b2b6e43-3f4e-4c55-9d2e-2a4a1d1a0001";

const ROW = {
  id: "b1",
  pageId: PAGE_A,
  ownerKey: "k",
  seq: 1,
  big: 2,
  rank: "a0",
  createdAt: "2026-10-19 10:00:00+00",
  weight: null,
  data: null,
  pageTitle: null,
  label: "K",
};

function script(q: RecordedQuery): unknown[] {
  if (/^SELECT \S+ AS __id /.test(q.sql)) return [{ __id: "b1" }];
  return [ROW];
}

function compile(key: string, by: readonly string[], s = spec()) {
  const rec = recordingQueryDb(script);
  const c = contracts(key, by);
  const out = compileAllCollection(
    { all: c.all, rows: c.rows },
    { ...s, db: rec.db },
  );
  // The params-generic halves, as the runtime holds them.
  const all = out.all as unknown as {
    loader(
      p: Record<string, string>,
      ctx?: { affectedIds: readonly string[] },
    ): Promise<unknown[]>;
    routes: RoutePlan<Record<string, string>>;
    scopedMembership: {
      orderOf(p: Record<string, string>): Promise<string[]>;
    };
    validateParams?: (p: Record<string, string>) => void;
  };
  return { ...out, all, calls: rec.calls, gated: c.gated };
}

const last = (calls: RecordedQuery[]): RecordedQuery => calls.at(-1)!;

/** The `"s_blocks"."<col>" = $n` predicates a statement reads, with their bound params. */
function scopePredicates(q: RecordedQuery): [string, unknown][] {
  return [...q.sql.matchAll(/"s_blocks"\."(\w+)" = \$(\d+)/g)].map((m) => [
    m[1]!,
    q.params[Number(m[2]) - 1],
  ]);
}

describe("one loop over `by`: the SQL, the route's match and the use's match agree", () => {
  test("every shape of the whole set reads `col = $param` for its tuple's params, `:rows` none", async () => {
    const c = compile("s-shapes", ["pageId"]);
    const params = { pageId: PAGE_A };
    await c.all.loader(params);
    const full = last(c.calls);
    expect(full.sql).toContain(
      `WHERE ("s_blocks"."deleted_at" IS NULL and "s_blocks"."page_id" = $`,
    );
    expect(full.sql).toContain(
      `ORDER BY "s_blocks"."rank" ASC NULLS LAST, "s_blocks"."created_at" ASC NULLS LAST, "s_blocks"."id" ASC NULLS LAST`,
    );
    expect(scopePredicates(full)).toEqual([["page_id", PAGE_A]]);
    await c.all.loader(params, { affectedIds: ["b1", "b2"] });
    const scoped = last(c.calls);
    expect(scoped.sql).toContain(`"s_blocks"."page_id" = $`);
    expect(scoped.sql).toContain(`"s_blocks"."id" = ANY($`);
    expect(scopePredicates(scoped)).toEqual([["page_id", PAGE_A]]);
    expect(await c.all.scopedMembership.orderOf(params)).toEqual(["b1"]);
    const orderIds = last(c.calls);
    expect(orderIds.sql).toBe(
      `SELECT "s_blocks"."id" AS __id FROM "s_blocks" WHERE ("s_blocks"."deleted_at" IS NULL and "s_blocks"."page_id" = $1) ORDER BY "s_blocks"."rank" ASC NULLS LAST, "s_blocks"."created_at" ASC NULLS LAST, "s_blocks"."id" ASC NULLS LAST`,
    );
    expect(orderIds.params).toEqual([PAGE_A]);
    // `:rows` is global: by id, no scope.
    await c.rows.loader({ ids: "b1" });
    expect(scopePredicates(last(c.calls))).toEqual([]);
  });

  test("the base identity route declares the scope columns as `match`; each tuple's base use matches its params and moves on them", () => {
    const c = compile("s-routes", ["pageId", "seq"]);
    const base = c.all.routes.routes.find((r) => r.id === "base")!;
    expect(base.map).toEqual({ kind: "identity" });
    expect(base.match).toEqual(["page_id", "seq"]);
    // The same routes serve `:rows` (one trigger layout per table).
    expect(c.rows.routes!.routes.find((r) => r.id === "base")!.match).toEqual([
      "page_id",
      "seq",
    ]);
    const uses = c.all.routes.usesOf({ pageId: PAGE_A, seq: "7" });
    expect(uses.get("base")).toEqual({
      role: "membership",
      match: { page_id: new Set([PAGE_A]), seq: new Set(["7"]) },
      moves: ["created_at", "deleted_at", "page_id", "rank", "seq"],
    });
    // Every other relation reads as it would unscoped.
    expect(uses.get("page")).toEqual({ role: "value" });
    // `:rows` matches nothing: an id read reaches the row whatever its scope.
    expect(c.rows.routes!.usesOf({ ids: "b1" }).get("base")).toEqual({
      role: "membership",
      moves: ["created_at", "deleted_at", "rank"],
    });
  });

  test("the use's match IS the SQL's predicate: same columns, same values, for any tuple", async () => {
    const c = compile("s-agree", ["pageId", "ownerKey", "seq"]);
    for (const params of [
      { pageId: PAGE_A, ownerKey: "k1", seq: "0" },
      {
        pageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        ownerKey: "a b,c",
        seq: "-42",
      },
    ]) {
      await c.all.loader(params);
      const predicates = scopePredicates(last(c.calls)).sort(([a], [b]) =>
        a < b ? -1 : 1,
      );
      const match = c.all.routes.usesOf(params).get("base")!.match!;
      expect(predicates).toEqual(
        Object.entries(match)
          .map(([col, values]): [string, unknown] => [col, [...values][0]])
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      );
      expect(Object.values(match).every((v) => v.size === 1)).toBe(true);
    }
  });

  test("an unscoped compile keeps its shape: no `match` on the route, no match in any use, `{}` reads no scope", async () => {
    const c = compile("s-unscoped", []);
    const base = c.all.routes.routes.find((r) => r.id === "base")!;
    expect("match" in base).toBe(false);
    expect(c.all.routes.usesOf({}).get("base")).toEqual({
      role: "membership",
      moves: ["created_at", "deleted_at", "rank"],
    });
    expect(c.all.validateParams).toBeUndefined();
    await c.all.loader({});
    expect(scopePredicates(last(c.calls))).toEqual([]);
  });
});

describe("the server's params gate", () => {
  test("the descriptor's gate runs first, then each value must be its column type's canonical text", () => {
    const c = compile("s-gate", ["pageId", "ownerKey", "seq", "big"]);
    const gate = c.all.validateParams!;
    const ok = { pageId: PAGE_A, ownerKey: "Any Text", seq: "12", big: "-3" };
    expect(() => gate(ok)).not.toThrow();
    expect(c.gated).toEqual([ok]);
    const refused: [Record<string, string>, RegExp][] = [
      [
        { ...ok, pageId: PAGE_A.toUpperCase() },
        /param "pageId" must be a uuid in canonical form/,
      ],
      [{ ...ok, pageId: "nope" }, /param "pageId" must be a uuid/],
      [
        { ...ok, seq: "012" },
        /param "seq" must be the canonical decimal text of a integer/,
      ],
      [{ ...ok, seq: "1.0" }, /param "seq" must be/],
      [{ ...ok, seq: "2147483648" }, /param "seq" must be/],
      [{ ...ok, big: "9223372036854775808" }, /param "big" must be/],
      [{ ...ok, big: "+1" }, /param "big" must be/],
    ];
    for (const [params, message] of refused) {
      let thrown: unknown;
      try {
        gate(params);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ResourceContractError);
      expect(String(thrown)).toMatch(message);
    }
    expect(() =>
      gate({ ...ok, seq: "2147483647", big: "-9223372036854775808" }),
    ).not.toThrow();
  });
});

describe("the definition (A18)", () => {
  test("is computed over a placeholder scope: stable, and moved by the scope", () => {
    const a = compile("s-def", ["pageId"]).definition;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(compile("s-def", ["pageId"]).definition).toBe(a);
    expect(compile("s-def", []).definition).not.toBe(a);
    expect(compile("s-def", ["ownerKey"]).definition).not.toBe(a);
  });
});

describe("refusals", () => {
  const refuses = (by: readonly string[], pattern: RegExp) =>
    expect(() => compile("s-bad", by)).toThrow(pattern);

  test("a scope field that reads no base column: a joined column, an expression", () => {
    refuses(
      ["pageTitle"],
      /the scope field "pageTitle" \(`all.by`\) reads no base column/,
    );
    refuses(
      ["label"],
      /the scope field "label" \(`all.by`\) reads no base column/,
    );
  });

  test("a scope column whose text is not one canonical spelling: a timestamp, a float", () => {
    refuses(
      ["createdAt"],
      /the scope field "createdAt" \(`all.by`\) is a timestamp with time zone column — a scope is text, uuid or an integer/,
    );
    refuses(
      ["weight"],
      /the scope field "weight" \(`all.by`\) is a double precision column/,
    );
  });

  test("a decoded column (sql-column): its param is bound as stored text, which a decoder may not round-trip", () => {
    const base = spec();
    const s = spec({
      select: (bind) => ({
        ...base.select(bind),
        status: bind.render(bind.j.base.status),
      }),
    });
    expect(() => compile("s-bad", ["status"], s)).toThrow(
      /the scope field "status" \(`all.by`\) is a decoded column \(sql-column\)/,
    );
  });

  test("a scope field that is not projected", () => {
    refuses(["nope"], /the scope field "nope" \(`all.by`\) is not projected/);
  });
});
