/**
 * Follows (`./follow`, research/2026-10-24-global-live-narrowed-reads.md §2):
 * a computed value's reach copies a collection's own minted plan for the
 * tuple it reads. Pinned here, against the recording `QueryDb`:
 *
 * - `{ ids }` of a `:rows` point set: every route is the collection's own —
 *   its id, gate (`columns`) and static rows kept —, mapped `full`, tagged
 *   `via` the follow; the base route matches on the identity column, each
 *   follower tuple's base use on exactly its ids; a join's far side stays
 *   gated with no match; an empty id set reads (and is reached by) nothing;
 *   an id the identity column's text cannot equal (a non-canonical uuid) is
 *   refused, and a follow of an identity whose text has no one spelling (a
 *   timestamp) is refused when declared;
 * - `{ where }` of a scoped `all` set: the base route matches on the scope
 *   columns (the compile's own `scopeOf` match — carried old ∪ new by the
 *   feed, so a re-pointed row reaches both its scopes), each tuple's use on
 *   its scope; a scope the column's text cannot equal is refused by the
 *   collection's own gate;
 * - `compiledValueReach` folds follows beside `reads` (optional with one): a
 *   followed table read whole or through a lookup too is refused, as is a
 *   hand-made read; a value declaring neither is refused.
 *
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { describe, expect, test } from "bun:test";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import {
  BASE_RELATION,
  type AllQueryResourceContract,
  type LookupJoin,
  type PointQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb } from "../testing/recording-db";
import { compileAllCollection } from "./compile-alias";
import { compileLookup } from "./compile-lookup";
import { compileWindowQuery } from "./compile-window";
import { followRead, type FollowablePlan, type FollowRead } from "./follow";
import { compileJoins } from "./joins";
import { compiledValueReach, routedBase } from "./routes";

const convs = pgTable("fo_conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  title: text("title"),
  viewedAt: text("viewed_at"),
});
const atts = pgTable("fo_attempts", {
  id: text("id").primaryKey(),
  worktreePath: text("worktree_path"),
  taskId: text("task_id"),
});
const blocks = pgTable("fo_blocks", {
  id: text("id").primaryKey(),
  pageId: uuid("page_id").notNull(),
  rank: text("rank").notNull(),
});

const attemptJoin = {
  kind: "lookup",
  alias: "attempt",
  table: atts,
  pk: atts.id,
  on: { from: BASE_RELATION, col: convs.attemptId },
  required: false,
} satisfies LookupJoin<"attempt", typeof atts>;

const point = {
  decode: (p: Record<string, string>) =>
    p.ids === "" || p.ids === undefined ? [] : p.ids!.split(","),
  encode: (ids: readonly string[]) => ({ ids: [...ids].sort().join(",") }),
  maxIds: 100,
};

/** A lookup-only `:rows` over conversations, joined to its attempt (`conversationWorkspaces`' shape). */
function workspaces(): FollowablePlan {
  const contract = {
    key: "fo-ws:rows",
    schema: z.array(z.object({ id: z.string() }).passthrough()),
    keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
    queryPk: "id",
    point,
    validateParams: () => {},
  } as unknown as PointQueryResourceContract<{ id: string }>;
  const plan = compileJoins(
    routedBase(convs, "test"),
    [attemptJoin],
    convs.id,
    "test",
  );
  const compiled = compileWindowQuery(contract, {
    from: convs,
    joins: [attemptJoin],
    select: {
      id: convs.id,
      attemptId: convs.attemptId,
      worktreePath: plan.render({ from: "attempt", col: atts.worktreePath }),
    },
    point: { by: convs.id },
    db: recordingQueryDb().db,
  });
  if (compiled.followable === null)
    throw new Error("a point set is followable");
  return compiled.followable;
}

/** A scoped `all` set of blocks by page (`all: { by: ["pageId"] }`). */
function pageBlocks(): FollowablePlan {
  const all = {
    key: "fo-blocks",
    schema: z.array(z.object({ id: z.string() }).passthrough()),
    keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
    all: {
      orderBy: [["rank", "asc"]],
      unbounded: { reason: "a test set" },
      by: ["pageId"],
    },
    queryPk: "id",
    validateParams: () => {},
  } as unknown as AllQueryResourceContract<{ id: string }, string>;
  const rows = {
    key: "fo-blocks:rows",
    queryPk: "id",
    point,
  } as unknown as PointQueryResourceContract<{ id: string }>;
  const out = compileAllCollection(
    { all, rows },
    {
      from: blocks,
      select: ({ j, render }) => ({
        id: render(j.base.id),
        pageId: render(j.base.pageId),
        rank: render(j.base.rank),
      }),
      db: recordingQueryDb().db,
    },
  );
  if (out.followable.all === null)
    throw new Error("a scoped set is followable by where");
  return out.followable.all;
}

const PAGE = "0b2b6e43-3f4e-4c55-9d2e-2a4a1d1a0001";

const uuidKeyed = pgTable("fo_uuid_keyed", { id: uuid("id").primaryKey() });
const timeKeyed = pgTable("fo_time_keyed", {
  id: timestamp("id", { withTimezone: true }).primaryKey(),
});

/** A lookup-only `:rows` over a one-column table keyed by `id`. */
function pointOver(
  table: typeof uuidKeyed | typeof timeKeyed,
  key: string,
): FollowablePlan {
  const contract = {
    key,
    schema: z.array(z.object({ id: z.unknown() }).passthrough()),
    keyed: { keyOf: (r: unknown) => String((r as { id: unknown }).id) },
    queryPk: "id",
    point,
    validateParams: () => {},
  } as unknown as PointQueryResourceContract<{ id: string }>;
  const compiled = compileWindowQuery(contract, {
    from: table,
    select: { id: table.id },
    point: { by: table.id },
    db: recordingQueryDb().db,
  });
  if (compiled.followable === null)
    throw new Error("a point set is followable");
  return compiled.followable;
}

describe("{ ids } — a `:rows` point set's plan, copied", () => {
  test("every route is the collection's own: gate kept, mapped full, tagged via; the base matched on the identity, the far side gated with no match", () => {
    const followable = workspaces();
    const read = followRead<{ conv: string }>(followable, "ws", (p) => ({
      ids: [p.conv],
    }));
    expect(read.collection).toBe("fo-ws:rows");
    const own = new Map(followable.plan.routes.map((r) => [r.id, r]));
    expect(read.routes.map((r) => r.id).sort()).toEqual(
      [...own.keys()].map((id) => `ws:${id}`).sort(),
    );
    for (const route of read.routes) {
      const source = own.get(route.id.slice("ws:".length))!;
      expect(route.table).toBe(source.table);
      expect(route.columns).toEqual(source.columns);
      expect(route.map.kind).toBe("full");
      expect(route.via).toEqual({ name: "ws", collection: "fo-ws:rows" });
    }
    const base = read.routes.find((r) => r.table === "fo_conversations")!;
    expect(base.match).toEqual(["id"]);
    // The gate is the collection's: a `viewed_at` write skips.
    expect(base.columns).not.toContain("viewed_at");
    expect(base.columns).toContain("attempt_id");
    const far = read.routes.find((r) => r.table === "fo_attempts")!;
    expect(far.match).toBeUndefined();
    expect(far.columns).not.toContain("task_id");
  });

  test("each follower tuple's uses: the base matched on exactly its ids; an empty id set reads nothing", () => {
    const read = followRead<{ conv: string }>(workspaces(), "ws", (p) =>
      p.conv === "" ? { ids: [] } : { ids: [p.conv] },
    );
    const uses = read.usesOf({ conv: "c1" });
    const base = read.routes.find((r) => r.table === "fo_conversations")!;
    expect([...uses.get(base.id)!.match!.id!]).toEqual(["c1"]);
    const far = read.routes.find((r) => r.table === "fo_attempts")!;
    expect(uses.get(far.id)?.match).toBeUndefined();
    expect(read.usesOf({ conv: "" }).size).toBe(0);
  });

  test("an id the identity's text cannot equal is refused; an identity with no one spelling cannot be followed", () => {
    const read = followRead<{ id: string }>(
      pointOver(uuidKeyed, "fo-uuid:rows"),
      "u",
      (p) => ({ ids: [p.id] }),
    );
    expect([...read.usesOf({ id: PAGE }).values()][0]!.match!.id).toEqual(
      new Set([PAGE]),
    );
    expect(() => read.usesOf({ id: PAGE.toUpperCase() })).toThrow(
      /canonical form/,
    );
    expect(() =>
      followRead<{ id: string }>(
        pointOver(timeKeyed, "fo-time:rows"),
        "t",
        (p) => ({ ids: [p.id] }),
      ),
    ).toThrow(/timestamp with time zone/);
  });

  test("a tuple of the other form is refused", () => {
    const read = followRead<ResourceParams>(
      workspaces(),
      "ws",
      () => ({ where: { x: "1" } }) as never,
    );
    expect(() => read.usesOf({})).toThrow(/not `\{ ids \}`/);
  });
});

describe("{ where } — a scoped `all` set's plan, copied", () => {
  test("the base route matches on the scope column (carried old ∪ new by the feed: a re-scoped row reaches both tuples)", () => {
    const read = followRead<{ page: string }>(pageBlocks(), "blocks", (p) => ({
      where: { pageId: p.page },
    }));
    const base = read.routes.find((r) => r.table === "fo_blocks")!;
    expect(base.match).toEqual(["page_id"]);
    expect(base.via).toEqual({ name: "blocks", collection: "fo-blocks" });
    const uses = read.usesOf({ page: PAGE });
    expect([...uses.get(base.id)!.match!.page_id!]).toEqual([PAGE]);
  });

  test("a scope the column's text cannot equal is refused by the collection's own gate", () => {
    const read = followRead<{ page: string }>(pageBlocks(), "blocks", (p) => ({
      where: { pageId: p.page },
    }));
    expect(() => read.usesOf({ page: PAGE.toUpperCase() })).toThrow(
      /canonical form/,
    );
  });

  test("an unminted followable is refused", () => {
    const fake = { ...pageBlocks() } as Record<PropertyKey, unknown>;
    for (const sym of Object.getOwnPropertySymbols(fake)) delete fake[sym];
    expect(() =>
      followRead(fake as unknown as FollowablePlan, "x", () => ({ ids: [] })),
    ).toThrow(/not minted by a collection compile/);
  });
});

describe("compiledValueReach with follows", () => {
  const ws = () =>
    followRead<{ conv: string }>(workspaces(), "ws", (p) => ({
      ids: [p.conv],
    })) as FollowRead<{ conv: string }>;

  test("reads are optional beside a follow; its routes join the plan with their uses", () => {
    const plan = compiledValueReach<{ conv: string }>(undefined, "v", [ws()]);
    expect(plan.routes.every((r) => r.via?.name === "ws")).toBe(true);
    const uses = plan.usesOf({ conv: "c1" });
    expect([...uses.keys()].sort()).toEqual(
      plan.routes.map((r) => r.id).sort(),
    );
  });

  test("a followed table also read whole, or through a lookup, is refused", () => {
    expect(() =>
      compiledValueReach<{ conv: string }>(
        { tables: [convs], reason: "whole" },
        "v",
        [ws()],
      ),
    ).toThrow(/read through the follow "ws" of "fo-ws:rows" and whole/);
    const lookup = compileLookup({
      label: "test.fo-lookup",
      from: atts,
      by: atts.id,
      select: { path: { from: "base", col: atts.worktreePath } },
      row: z.object({ path: z.string().nullable() }),
      db: recordingQueryDb().db,
    });
    expect(() =>
      compiledValueReach<{ conv: string }>(
        {
          tables: [],
          lookups: [lookup.read<{ conv: string }>((p) => p.conv)],
          reason: "lookup",
        },
        "v",
        [ws()],
      ),
    ).toThrow(/and through a lookup/);
  });

  test("a hand-made follow read, a follow twice, and a value declaring nothing are refused", () => {
    const read = ws();
    const forged = {
      name: read.name,
      collection: read.collection,
      routes: read.routes,
      usesOf: read.usesOf,
    } as unknown as FollowRead<{ conv: string }>;
    expect(() => compiledValueReach(undefined, "v", [forged])).toThrow(
      /followRead did not mint/,
    );
    expect(() => compiledValueReach(undefined, "v", [ws(), ws()])).toThrow(
      /listed twice/,
    );
    expect(() => compiledValueReach(undefined, "v", [])).toThrow(
      /declares what its loader reads/,
    );
  });

  test("other tables keep their whole-table routes beside the follow", () => {
    const plan = compiledValueReach<{ conv: string }>(
      { tables: [blocks], reason: "every block" },
      "v",
      [ws()],
    );
    const whole = plan.routes.find((r) => r.table === "fo_blocks")!;
    expect(whole.via).toBeUndefined();
    expect(plan.usesOf({ conv: "c1" }).get(whole.id)).toEqual({
      role: "membership",
    });
  });
});
