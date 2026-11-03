/**
 * D31 — an EXTERNAL keyed window / point set takes a full-only reach plan: a
 * change its tuples' uses let through re-reads that tuple whole, and the
 * route gates (`columns`) and per-tuple `match` narrow WHICH tuples re-read —
 * the shape a paged value reading through a compiled lookup gets
 * (query-resource's `compileLookup` + `compiledValueReach`). And the tagged
 * reads that lookup's tables are covered by (`TaggedRead`): a capture reading
 * one outside the tag is drift (A8 / D5), failed open — the table then
 * reaches the entry FULL, ungated.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintReachPlan, type TableChange, type TupleUse } from "./routing";
import { createHarness, tick } from "./test-support";
import type { ReadTags, ResourceParams } from "./runtime";

const settle = async () => {
  await tick();
  await tick();
};

const LOOKUP = "test.workspace-of";

/**
 * The plan a lookup "conversation → its attempt's checkout" compiles to: the
 * key table matched per tuple on its id, gated on what the SQL reads; the
 * joined table gated, unmatched (a tuple cannot know its attempt statically).
 */
function lookupReach() {
  return mintReachPlan<ResourceParams>({
    routes: [
      {
        id: `${LOOKUP}:conversations`,
        table: "conversations",
        map: { kind: "full", reason: "a lookup re-reads its reader whole" },
        columns: ["attempt_id", "id"],
        match: ["id"],
      },
      {
        id: `${LOOKUP}:attempt`,
        table: "attempts",
        map: { kind: "full", reason: "a lookup re-reads its reader whole" },
        columns: ["id", "worktree_path"],
      },
    ],
    usesOf: (p) =>
      new Map<string, TupleUse>([
        [
          `${LOOKUP}:conversations`,
          { role: "membership", match: { id: new Set([p.conv!]) } },
        ],
        [`${LOOKUP}:attempt`, { role: "membership" }],
      ]),
    taggedReads: [
      { table: "conversations", tag: LOOKUP },
      { table: "attempts", tag: LOOKUP },
    ],
  });
}

const contract = (key: string) => ({
  key,
  schema: z.array(z.object({ id: z.string() })),
  keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
  validateParams: () => {},
});

function pagesOver(
  h: ReturnType<typeof createHarness>,
  key = "pages",
): string[] {
  const loads: string[] = [];
  h.runtime.defineExternalResource(contract(key), {
    membership: { kind: "window", limitOf: () => 10 },
    reach: lookupReach(),
    loader: (p: ResourceParams) => {
      loads.push(p.conv!);
      return [{ id: `${p.conv}-${loads.length}` }];
    },
    freshness: { kind: "notified" },
  });
  return loads;
}

const change = (
  table: string,
  op: TableChange["op"],
  ids: string[],
  unchanged: string[] | null = null,
): TableChange => ({
  source: "feed",
  table,
  op,
  ids,
  keys: { id: ids },
  unchanged,
});

describe("an external keyed window's reach plan (D31: full-only)", () => {
  test("a gated U reaches no page; a key-table I / D only its own question's; a joined-table I every page", async () => {
    const h = createHarness();
    const loads = pagesOver(h);
    await h.subscribe("pages", { conv: "a" });
    await h.subscribe("pages", { conv: "b" });
    loads.length = 0;

    // A conversation's turn: a column the lookup does not read.
    h.runtime.routeTableChange(
      change("conversations", "U", ["a"], ["attempt_id", "id"]),
    );
    await settle();
    expect(loads).toEqual([]);

    // A's row inserted: only A's page re-reads, whole.
    h.runtime.routeTableChange(change("conversations", "I", ["a"]));
    await settle();
    expect(loads).toEqual(["a"]);
    expect(h.pushesFor("pages").map((f) => f.kind)).toContain("delta");

    loads.length = 0;
    h.runtime.routeTableChange(change("conversations", "D", ["b"]));
    await settle();
    expect(loads).toEqual(["b"]);

    // Another conversation's row: no page asks about it.
    loads.length = 0;
    h.runtime.routeTableChange(change("conversations", "I", ["z"]));
    await settle();
    expect(loads).toEqual([]);

    // An attempt the lookup may read: every page, once each.
    h.runtime.routeTableChange(change("attempts", "I", ["att-1"]));
    await settle();
    expect(loads.sort()).toEqual(["a", "b"]);
    // ...but not one that leaves the lookup's columns as they were.
    loads.length = 0;
    h.runtime.routeTableChange(
      change("attempts", "U", ["att-1"], ["id", "worktree_path"]),
    );
    await settle();
    expect(loads).toEqual([]);
  });

  test("the trigger layout carries the match column and the gates", () => {
    const h = createHarness();
    pagesOver(h);
    expect(h.runtime.routedTableRequirements()).toEqual([
      { table: "attempts", carry: [], reads: [["id", "worktree_path"]] },
      { table: "conversations", carry: ["id"], reads: [["attempt_id", "id"]] },
    ]);
  });

  test("a point set takes one too", async () => {
    const h = createHarness();
    const loads: number[] = [];
    h.runtime.defineExternalResource(contract("rows"), {
      membership: { kind: "point", idsOf: (p) => p.ids!.split(",") },
      reach: lookupReach(),
      loader: () => {
        loads.push(1);
        return [];
      },
      freshness: { kind: "notified" },
    });
    await h.subscribe("rows", { ids: "x", conv: "a" });
    loads.length = 0;
    h.runtime.routeTableChange(change("conversations", "I", ["a"]));
    await settle();
    expect(loads).toEqual([1]);
  });

  test("refused: a non-full route, and a reach plan on a routed or a non-external keyed entry", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineExternalResource(contract("mapped"), {
        membership: { kind: "window", limitOf: () => 10 },
        reach: mintReachPlan({
          routes: [
            {
              id: "t",
              table: "t",
              map: { kind: "identity" },
              columns: ["id"],
            },
          ] as never,
          usesOf: () => new Map(),
        }),
        loader: () => [],
        freshness: { kind: "notified" },
      }),
    ).toThrow(/every reach route is "full"/);
    expect(() =>
      h.runtime.defineResource(contract("db-keyed"), {
        loader: () => [],
        membership: { kind: "point", idsOf: () => [] },
        ...({ reach: lookupReach() } as object),
      } as never),
    ).toThrow(/requires routes|"reach" is the non-keyed arm/);
  });
});

describe("tagged reads — a lookup's tables are covered only by its own statement", () => {
  const tagsOf = (entries: [string, (string | null)[]][]): ReadTags =>
    new Map(entries.map(([t, tags]) => [t, new Set(tags)]));

  function guarded(tags: ReadTags | undefined, strictRoutes: boolean) {
    const reports: string[] = [];
    const h = createHarness({
      lastReadSet: () => ["conversations", "attempts"],
      lastReadTags: () => tags,
      strictRoutes,
      reportError: (label) => reports.push(label),
    });
    const loads = pagesOver(h);
    return { h, loads, reports };
  }

  test("every read of them tagged with the lookup: covered, even under strictRoutes", async () => {
    const { h } = guarded(
      tagsOf([
        ["conversations", [LOOKUP]],
        ["attempts", [LOOKUP]],
      ]),
      true,
    );
    await h.subscribe("pages", { conv: "a" });
    expect(h.frames.map((f) => f.kind)).toEqual(["sub-ack"]);
  });

  test("an untagged read of one, or no tags captured at all: drift", async () => {
    for (const tags of [
      tagsOf([
        ["conversations", [LOOKUP, null]],
        ["attempts", [LOOKUP]],
      ]),
      tagsOf([
        ["conversations", ["another-lookup"]],
        ["attempts", [LOOKUP]],
      ]),
      undefined,
    ]) {
      const { h } = guarded(tags, true);
      await h.subscribe("pages", { conv: "a" });
      expect(h.frames.map((f) => f.kind)).toEqual(["sub-error"]);
    }
  });

  test("in a running server the drift fails open: the table reaches every page FULL, its gate no longer decides", async () => {
    const { h, loads, reports } = guarded(
      tagsOf([
        ["conversations", [LOOKUP, null]],
        ["attempts", [LOOKUP]],
      ]),
      false,
    );
    await h.subscribe("pages", { conv: "a" });
    await h.subscribe("pages", { conv: "b" });
    expect(reports).toContain("route drift for pages");
    loads.length = 0;
    // Gated out before the drift — now every page re-reads.
    h.runtime.routeTableChange(
      change("conversations", "U", ["z"], ["attempt_id", "id"]),
    );
    await settle();
    expect(loads.sort()).toEqual(["a", "b"]);
    // The table read only through its tag keeps its gate.
    loads.length = 0;
    h.runtime.routeTableChange(
      change("attempts", "U", ["att-1"], ["id", "worktree_path"]),
    );
    await settle();
    expect(loads).toEqual([]);
  });

  test("a persisted tables_read (no tags) judges a tagged table by its name: covered, not seeded", () => {
    const h = createHarness();
    pagesOver(h);
    expect(
      h.runtime.seedRouteDrift([
        { key: "pages", tablesRead: ["conversations"] },
      ]),
    ).toEqual([]);
  });

  test("minting refuses a tagged read of no route table, an empty tag, one twice", () => {
    const route = {
      id: "t",
      table: "t",
      map: { kind: "full" as const, reason: "r" },
      columns: ["id"],
    };
    const mint = (taggedReads: { table: string; tag: string }[]) =>
      mintReachPlan({ routes: [route], usesOf: () => new Map(), taggedReads });
    expect(() => mint([{ table: "u", tag: "x" }])).toThrow(/no route table/);
    expect(() => mint([{ table: "t", tag: " " }])).toThrow(/empty tag/);
    expect(() =>
      mint([
        { table: "t", tag: "x" },
        { table: "t", tag: "x" },
      ]),
    ).toThrow(/listed twice/);
  });
});
