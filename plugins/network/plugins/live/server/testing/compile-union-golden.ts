// The union SQL + routes snapshot (C6 of
// research/2026-10-06-global-scoped-change-routing-p8-v3.md, step 16·0): a
// fixed union declaration — four arms over a text, a text-with-lookup, an
// integer and a uuid-with-required-lookup primary key — compiled by `compileUnion` (network/live's half: the
// filter targets, arm pruning, the wire fold) into query-resource's
// `compileUnionCollection`, against the recording `QueryDb`, and driven
// through every shape: the window's full / scoped / `windowIdsOf` loads and
// order signatures per tuple (default, kind-pruned, ordered by a lookup read,
// an arm column's filter and order, both page cuts, every arm pruned), the
// `:rows` point read (a bad integer id, an unknown kind, another arm's key),
// the `:groups` loads, and each half's routes (gates, roles, `moves`, the
// reverse probe re-keyed into `kind:raw`, the identity / alias maps' arm-key
// `encode` called on fixed raw ids) and `usesOf`. Between them the arms render
// both join kinds (b's LEFT lookup, u's required INNER one), both id paths
// (text `= ANY`, and `pg_input_is_valid` for n's integer and u's uuid), and a
// read spelled with a type alias (u's `timestamptz` against the column's
// `timestamp with time zone`).
//
// The union is not in the compile-SQL golden (`compile-sql-golden.ts`); 16b
// moves its private SQL helpers into `raw-sql.ts` and generalizes the routed
// half it shares with the single-table compile, so this pins those refactors
// byte for byte. `gen-compile-union-golden.ts` (beside this file) writes the
// record to `compile-union-golden.json`;
// `server/internal/compile-union-golden.test.ts` recomputes and compares.

import { fileURLToPath } from "node:url";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  expr,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import {
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import {
  clause,
  liveInstant,
  liveNumber,
  liveText,
  or,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { liveArmColumns, liveCollection } from "../../core";
import { compileUnion, type UnionArmBinding } from "../internal/serve-union";
import {
  groupsRecord,
  plain,
  pointRecord,
  windowRecord,
  type Harness,
  type Json,
  type ServerOpts,
} from "./compile-sql-golden";

/** The fixture's absolute path (`plugins/network/plugins/live/server/testing/compile-union-golden.json`). */
export const COMPILE_UNION_GOLDEN_FILE = fileURLToPath(
  new URL("./compile-union-golden.json", import.meta.url),
);

// ── The schema: four arms ──────────────────────────────────────────────────

const servers = pgTable("golden_union_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
/** `a` — an arm `where`, an outcome expression, its own nullable column, a `pid` no shape reads. */
const aRuns = pgTable("golden_union_a", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull(),
  code: integer("code"),
  ns: text("ns").notNull(),
  pid: integer("pid"),
});
/** `b` — a LEFT lookup its label reads (a reverse route). */
const bRuns = pgTable("golden_union_b", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  comp: text("comp").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pid: integer("pid"),
});
/** `n` — an integer primary key (ids filtered by `pg_input_is_valid`), no `finishedAt` notion. */
const nRuns = pgTable("golden_union_n", {
  seq: integer("seq").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  size: integer("size").notNull(),
});

const owners = pgTable("golden_union_owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
/** `u` — a uuid primary key, a REQUIRED lookup (an INNER JOIN, membership), a `timestamptz`-spelled start. */
const uRuns = pgTable("golden_union_u", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

const Row = z.object({
  runKey: z.string(),
  kind: z.string(),
  id: z.string(),
  label: z.string(),
  outcome: z.string(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
});

const runs = liveCollection("golden-union.runs", {
  row: Row,
  id: "runKey",
  arms: { discriminator: "kind" },
  filterable: {
    kind: liveText(),
    label: liveText(),
    outcome: liveText(),
    startedAt: liveInstant(),
  },
  sortable: ["kind", "label", "startedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: 4 },
  maxLimit: 12,
});
const aColumns = liveArmColumns(runs, "a", {
  row: z.object({ code: z.number().nullable() }),
  filterable: { code: liveNumber() },
  sortable: ["code"],
});
const bColumns = liveArmColumns(runs, "b", {
  row: z.object({ server: z.string() }),
  filterable: { server: liveText() },
  sortable: ["server"],
});
const nColumns = liveArmColumns(runs, "n", {
  row: z.object({ size: z.number() }),
  filterable: { size: liveNumber() },
  sortable: ["size"],
});

const uColumns = liveArmColumns(runs, "u", {
  row: z.object({ owner: z.string() }),
  filterable: { owner: liveText() },
  sortable: ["owner"],
});

const serverJoin: LookupJoin<"server", typeof servers> = {
  kind: "lookup",
  alias: "server",
  table: servers,
  pk: servers.id,
  on: { from: "base", col: bRuns.serverId },
  required: false,
};

const ownerJoin: LookupJoin<"owner", typeof owners> = {
  kind: "lookup",
  alias: "owner",
  table: owners,
  pk: owners.id,
  on: { from: "base", col: uRuns.ownerId },
  required: true,
};

type Refs = Record<string, Record<string, unknown>>;
const ARMS: UnionArmBinding[] = [
  {
    columns: aColumns,
    from: aRuns,
    id: aRuns.id,
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: j.base!.id!,
        label: j.base!.label!,
        outcome: expr(
          sql`(case when ${r.base!.finishedAt} is null then 'running' else ${r.base!.status} end)`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        startedAt: j.base!.startedAt!,
        finishedAt: j.base!.finishedAt!,
      };
    },
    extra: (j) => ({ code: j.base!.code! }),
    where: (j) => eq(j.base!.ns!, "here"),
  },
  {
    columns: bColumns,
    from: bRuns,
    id: bRuns.id,
    joins: [serverJoin],
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: j.base!.id!,
        label: expr(
          sql`${r.base!.comp} || ' on ' || coalesce(${r.server!.name}, ${r.base!.serverId})`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        outcome: expr(
          sql`(case when ${r.base!.finishedAt} is null then 'running' else 'succeeded' end)`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        startedAt: j.base!.startedAt!,
        finishedAt: j.base!.finishedAt!,
      };
    },
    extra: (j) => ({ server: j.base!.serverId! }),
  },
  {
    columns: nColumns,
    from: nRuns,
    id: nRuns.seq,
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: expr(sql`(${r.base!.seq})::text`, {
          decoder: String,
          sqlType: "text",
          notNull: true,
        }),
        label: j.base!.name!,
        outcome: j.base!.state!,
        startedAt: j.base!.startedAt!,
        finishedAt: null,
      };
    },
    extra: (j) => ({ size: j.base!.size! }),
  },
  {
    columns: uColumns,
    from: uRuns,
    id: uRuns.id,
    joins: [ownerJoin],
    base: (j) => {
      const r = j as unknown as Refs;
      return {
        id: expr(sql`(${r.base!.id})::text`, {
          decoder: String,
          sqlType: "text",
          notNull: true,
        }),
        label: j.base!.title!,
        outcome: expr(
          sql`(case when ${r.base!.finishedAt} is null then 'running' else 'succeeded' end)`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        // The same instant, cast and typed with the alias the type check folds.
        startedAt: expr(sql`(${r.base!.startedAt})::timestamptz`, {
          decoder: (v: unknown) => new Date(String(v)),
          sqlType: "timestamptz",
          notNull: true,
        }),
        finishedAt: j.base!.finishedAt!,
      };
    },
    extra: (j) => ({ owner: j.owner!.name! }),
  },
];

// ── The recording db's answers ──────────────────────────────────────────────

/**
 * One positional row per arm, as Postgres would hand it back: `__kind`,
 * `__key`, then `__c<i>` in the compile's column order (the base fields
 * `id, label, outcome, startedAt, finishedAt`, then `a.code`, `b.server`,
 * `n.size`, `u.owner`) — NULL where the arm reads none.
 */
/** u's sample row id (a uuid). */
const U_ID = "0b8e2c1e-7f4a-4c1d-9a39-3f2d5f0c6a11";

const SAMPLE: Record<string, Record<string, unknown>> = {
  a: {
    __kind: "a",
    __key: "a:a1",
    __c0: "a1",
    __c1: "build one",
    __c2: "running",
    __c3: "2026-10-01 10:00:00+00",
    __c4: null,
    __c5: 3,
    __c6: null,
    __c7: null,
    __c8: null,
  },
  b: {
    __kind: "b",
    __key: "b:x:y",
    __c0: "x:y",
    __c1: "comp on srv",
    __c2: "succeeded",
    __c3: "2026-10-01 09:00:00+00",
    __c4: "2026-10-01 09:30:00+00",
    __c5: null,
    __c6: "s1",
    __c7: null,
    __c8: null,
  },
  n: {
    __kind: "n",
    __key: "n:7",
    __c0: "7",
    __c1: "seventh",
    __c2: "queued",
    __c3: "2026-10-01 08:00:00+00",
    __c4: null,
    __c5: null,
    __c6: null,
    __c7: 42,
    __c8: null,
  },
  u: {
    __kind: "u",
    __key: `u:${U_ID}`,
    __c0: U_ID,
    __c1: "owned run",
    __c2: "running",
    __c3: "2026-10-01 07:00:00+00",
    __c4: null,
    __c5: null,
    __c6: null,
    __c7: null,
    __c8: "owner one",
  },
};

/**
 * The answer to each recorded query: a reverse probe's hosts, a grouping's
 * counts (one NULL group), `windowIdsOf`'s keys, and otherwise one sample row
 * per arm the SQL selects from — each carrying every row-key part
 * (`__p<i>`) the SQL projects (the `n` row's first part NULL, the `b` row's
 * over the 1 KiB row-key bound).
 */
function script(q: RecordedQuery): unknown[] {
  if (q.sql.startsWith("select distinct")) return [{ id: "x:y" }, { id: "b2" }];
  if (q.sql.includes(`count(*)`)) {
    return [
      { value: "a", count: 2 },
      { value: null, count: 1 },
    ];
  }
  const kinds = Object.keys(SAMPLE).filter((k) =>
    q.sql.includes(`'${k}'::text AS "__kind"`),
  );
  if (q.sql.startsWith(`SELECT u."__key" AS "__key"`)) {
    return kinds.map((k) => ({ __key: SAMPLE[k]!.__key }));
  }
  const parts = [...q.sql.matchAll(/AS "(__p\d+)"/g)].map((m) => m[1]!);
  return kinds.map((k) => ({
    ...SAMPLE[k]!,
    ...Object.fromEntries(
      parts.map((part) => [
        part,
        k === "n" && part === "__p0"
          ? null
          : k === "b" && part === "__p0"
            ? `${part}:${"k".repeat(1100)}`
            : `${part}:${k}`,
      ]),
    ),
  }));
}

// ── The record ──────────────────────────────────────────────────────────────

/**
 * The whole union record, deterministic for one source tree: one compile, its
 * three halves driven through every shape in a fixed order.
 */
export async function recordUnionGolden(): Promise<Json> {
  const recording = recordingQueryDb(script);
  const h: Harness = {
    calls: recording.calls,
    counters: { where: 0, orderBy: 0 },
  };
  const compiled = compileUnion(runs, { arms: () => ARMS, db: recording.db });
  const w = runs.window.window;
  const g = runs.groups.groups;
  const cut = JSON.stringify(["2026-10-01 09:00:00+00", "b:x:y"]);
  const windowTuples: Record<string, ResourceParams> = {
    default: w.encode(),
    "kind-pruned": w.encode({ where: { kind: "b" }, limit: 6 }),
    // b's label reads the server lookup: ordering by it makes it membership.
    "label-asc": w.encode({ orderBy: [["label", "asc"]], limit: 5 }),
    // An arm column: prunes b and n (a NULL constant there).
    "arm-filter": w.encode({
      where: { "a.code": { gt: 0 } },
      columns: [aColumns],
      limit: 8,
    } as never),
    "arm-order": w.encode({
      orderBy: [
        ["n.size", "desc"],
        ["kind", "asc"],
      ],
      columns: [nColumns],
      limit: 3,
    } as never),
    // An OR prunes nothing: either alternative may hold.
    "or-filter": w.encode({
      where: or(clause("kind", "eq", "a"), clause("label", "contains", "on")),
      limit: 4,
    } as never),
    after: w.encode({}, { after: cut }),
    until: w.encode({}, { until: cut }),
    // A filter through u's required lookup (only u survives).
    "u-owner": w.encode({
      where: { "u.owner": { eq: "owner one" } },
      columns: [uColumns],
      limit: 4,
    } as never),
    "none-survive": w.encode({ where: { kind: "zzz" } } as never),
  };
  const window = await windowRecord(
    h,
    compiled.window as unknown as ServerOpts,
    windowTuples,
    [
      "a:a1",
      "b:x:y",
      "n:7",
      "n:abc",
      `u:${U_ID}`,
      "u:not-a-uuid",
      "q:1",
      "nope",
    ],
    { within: ["b:x:y", "a:a1", "b:b2", `u:${U_ID}`] },
  );
  const point = await pointRecord(
    h,
    compiled.rows as unknown as ServerOpts,
    {
      mixed: runs.rows.point.encode([
        "a:a1",
        "b:x:y",
        "n:7",
        "n:abc",
        `u:${U_ID}`,
        "u:not-a-uuid",
        "q:1",
      ]),
      "one-arm": runs.rows.point.encode(["n:7"]),
      unknown: runs.rows.point.encode(["q:1", "nope"]),
      none: runs.rows.point.encode([]),
    },
    ["b:x:y", "n:8", `u:${U_ID}`],
    { within: ["b:x:y"] },
  );
  const groups = await groupsRecord(h, compiled.groups as never, {
    kind: g.encode({ groupBy: "kind" }),
    outcome: g.encode({ groupBy: "outcome", where: { kind: "a" } } as never),
    // Only n survives: a and b read no kind "n".
    "label-pruned": g.encode({
      groupBy: "label",
      where: { kind: "n" },
    } as never),
  });
  return { window, point, groups: plain(groups) };
}
