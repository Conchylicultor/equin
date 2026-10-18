/**
 * Real-DB suite for the sidebar's document order (`docRank`): the order
 * `docOrderRows` derives and the `doc_rank` column the reconcile stores from
 * it, read back through `loadPages`. Headless — drives the db-parametrized
 * functions against a throwaway Postgres (db-test-fixture) with the REAL
 * migration chain, so the `page_blocks` self-FK and the partial unique rank
 * indexes are exactly what production applies.
 *
 * The seeds and the corruption shapes below write `page_blocks` by hand,
 * bypassing the chokepoint's doc-order marks on purpose, so every read goes
 * through {@link orderedPages}: the boot reconcile first (what a backend does
 * before it serves), then the loader. The writers' own maintenance of the
 * column is `doc-rank.test.ts`'s oracle.
 *
 * Run: `bun test plugins/page/plugins/editor/server/internal/page-doc-order.test.ts`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  installLoaderReadSetSink,
  installSpanContextRuntime,
  recordEntrySpan,
  resetRuntimeProfile,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  getReadSetIndex,
  removeReadSetTable,
} from "@plugins/framework/plugins/server-core/core/testing";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { pagesTree } from "../../core/resources";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { recordTrashEntry } from "@plugins/infra/plugins/trash/server";
import {
  collectContributions,
  recordLoaderReadSet,
} from "@plugins/framework/plugins/server-core/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { defineBlock } from "../../core";
import { pageBlockHandle } from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { docOrderPaths } from "./page-doc-order";
import { reconcileDocRanksAtBoot } from "./doc-rank-boot";
import { loadPages } from "./resources";
import { pageRowsServeOptions } from "./page-rows";
import { pageContentEditedAt } from "./rollup-spec";

// Stand-ins for the content block types the seeds nest sub-pages under. The
// concrete `page/text` + `page/toggle` plugins import THIS plugin, so importing
// them back would be a cycle; `seedBlock` only needs the type to resolve.
const textBlockStub = defineBlock({
  type: "text",
  schema: z.object({}),
  empty: () => ({}),
});
const toggleBlockStub = defineBlock({
  type: "toggle",
  schema: z.object({}),
  empty: () => ({}),
});

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "page_doc_order_test" });
  await runMigrations(t.db);
  // `loadPages` reads each page's `editedAt` off the content rollup, which a
  // backend installs at boot (`rebuildDerivedTables`) — the same path.
  await installRollups(t.db, [pageContentEditedAt]);
  collectContributions([
    {
      id: "page-doc-order-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        Editor.BlockData(toggleBlockStub),
      ],
    },
  ]);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

/**
 * Flag ONE row as trashed, by hand — the corruption shapes below need a trashed
 * row whose descendants stay live, which the real chokepoint (closed under
 * descendants) can never produce. Both flag columns are set together: the
 * `page_blocks_trash_flags_agree` CHECK rejects a bare `deleted_at`.
 */
async function flagTrashed(id: string): Promise<void> {
  const entryId = await recordTrashEntry(t.db, {
    sourceId: "pages",
    rootEntityId: id,
    label: id,
  });
  await t.db.execute(
    sql`UPDATE page_blocks SET deleted_at = now(), trash_entry_id = ${entryId} WHERE id = ${id}`,
  );
}

async function seedBlock(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
}): Promise<void> {
  await t.db.insert(_blocks).values({
    id: args.id,
    parentId: args.parentId,
    pageId: args.pageId,
    type: args.type,
    rank: args.rank,
    data: parseBlockData(
      args.type,
      args.type === "page" ? { title: args.id, icon: null } : undefined,
    ),
  });
}

/**
 * The loader's rows after the boot reconcile has brought the hand-written
 * state to invariant I-DR — what a backend serves.
 */
async function orderedPages(): Promise<Awaited<ReturnType<typeof loadPages>>> {
  await reconcileDocRanksAtBoot(t.db);
  return loadPages(t.db);
}

/** Page ids in the loader's array order, restricted to one sidebar group. */
async function orderIn(pageId: string | null): Promise<string[]> {
  const rows = await orderedPages();
  return rows.filter((r) => r.pageId === pageId).map((r) => r.id);
}

describe("document order across rank spaces", () => {
  /**
   * The incident shape, and the whole point of `docRank`: page W's sub-pages
   * live in TWO different `(parent_id, rank)` spaces — `direct` is a direct
   * child of W, while `nested` sits under a toggle block. Both legitimately hold
   * rank "a1" (different parents ⇒ no unique-index conflict), so the old global
   * `rank` sort was meaningless AND fed `Rank.between("a1","a1")` — which throws
   * and silently aborted the drop.
   *
   *   W
   *   ├── toggle       (rank a0)
   *   │   ├── nestedA  (page, rank a1)   ← document position 1
   *   │   └── nestedB  (page, rank a2)   ← document position 2
   *   └── direct       (page, rank a1)   ← document position 3
   */
  beforeEach(async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "toggle",
      parentId: "W",
      pageId: "W",
      type: "toggle",
      rank: "a0",
    });
    await seedBlock({
      id: "nestedA",
      parentId: "toggle",
      pageId: "W",
      type: "page",
      rank: "a1",
    });
    await seedBlock({
      id: "nestedB",
      parentId: "toggle",
      pageId: "W",
      type: "page",
      rank: "a2",
    });
    await seedBlock({
      id: "direct",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a1",
    });
  });

  test("resource order == document order, not a global rank sort", async () => {
    expect(await orderIn("W")).toEqual(["nestedA", "nestedB", "direct"]);
  });

  test("docRank is strictly ascending in array order within a group", async () => {
    const rows = (await orderedPages()).filter((r) => r.pageId === "W");
    for (let i = 1; i < rows.length; i++) {
      expect(Rank.compare(rows[i - 1]!.docRank, rows[i]!.docRank)).toBe(-1);
    }
  });

  test("docRank is unique within a group even where raw rank collides", async () => {
    const rows = (await orderedPages()).filter((r) => r.pageId === "W");
    // The precondition this whole change exists for.
    expect(rows.filter((r) => r.rank.toString() === "a1")).toHaveLength(2);
    const docRanks = rows.map((r) => r.docRank.toString());
    expect(new Set(docRanks).size).toBe(docRanks.length);
  });

  test("docRank derives from ranks, not content — a data.text write yields an identical result", async () => {
    const before = await orderedPages();
    await t.db.execute(
      sql`UPDATE page_blocks SET data = '{"text":"typing…"}'::jsonb WHERE id = 'toggle'`,
    );
    const after = await orderedPages();
    expect(after.map((r) => [r.id, r.docRank.toString()])).toEqual(
      before.map((r) => [r.id, r.docRank.toString()]),
    );
  });

  test("a trashed page leaves the group, the rest keep their order", async () => {
    await flagTrashed("nestedA");
    expect(await orderIn("W")).toEqual(["nestedB", "direct"]);
  });
});

describe("membership is never a function of the traversal", () => {
  // Hole B. A live page whose ancestor chain is broken (its `parentId` points at
  // a trashed row) must still APPEAR — otherwise it vanishes not just from the
  // sidebar but from the `[[` picker and breadcrumbs, and would never be given
  // a `doc_rank`. It is kept and deterministically placed last in its group.
  test("a page with a broken ancestor chain still appears, sorted last in its group", async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "ok",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a5",
    });
    await seedBlock({
      id: "gone",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "broken",
      parentId: "gone",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    // The dangling pointer: `broken`'s parent is trashed, so the upward walk
    // cannot reach W. (Unreachable through the UI — this is the corruption shape
    // the destination-parent liveness guard closes.)
    await flagTrashed("gone");

    const paths = await docOrderPaths(t.db);
    expect(paths.has("broken")).toBe(false); // no resolvable path…
    expect(await orderIn("W")).toEqual(["ok", "broken"]); // …but never dropped.
  });
});

describe("cycle guard", () => {
  // Hole C. A `parent_id` cycle would recurse forever and pin a pool connection
  // on a path that re-runs on every write. The depth cap terminates it; the
  // cycled page has no terminal row, so it falls to the unresolved branch.
  test("a parent_id cycle terminates and never drops the row", async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "x",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "y",
      parentId: "x",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "cycled",
      parentId: "y",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    // Close the loop: x → y → x. Seeded via raw SQL because the insert order
    // above cannot express it (the FK needs `y` to exist first).
    await t.db.execute(
      sql`UPDATE page_blocks SET parent_id = 'cycled' WHERE id = 'x'`,
    );

    const rows = await orderedPages();
    expect(rows.map((r) => r.id).sort()).toEqual(["W", "cycled"]);
  });
});

/**
 * Hole A, and the tests that MUST exist: this failure mode is silent.
 *
 * A live read that never learns it read `page_blocks` never refreshes — no
 * error, no log, every other test still green; the sidebar just stops
 * updating. The page tree is a ROUTED collection now (`pagesTree`), so the
 * edge is a ROUTE its compile emits, never a loader read-set: pinned first.
 *
 * The raw doc-order CTE is no live read, but the same quoting rule decides
 * whether any loader built on it keeps its edge. The read-set extractor
 * matches only DOUBLE-QUOTED identifiers (`\b(from|join)\s+"([^"]+)"`,
 * `plugins/database/server/internal/client.ts`), and capture happens in the
 * instrumented `pool.query` wrapper keyed on the ambient `loader` entry, so
 * that probe runs against the REAL worktree DB (read-only — a pure select)
 * rather than the fixture's own uninstrumented pool.
 */
describe("read-set (Hole A)", () => {
  // Inject the recorder's ambient runtime and the read-set sink exactly the way
  // runtime-profiler/server/internal/install.ts does at boot.
  beforeEach(() => {
    const als = new AsyncLocalStorage<EntryContext>();
    installSpanContextRuntime({
      run: (ctx, fn) => als.run(ctx, fn),
      current: () => als.getStore(),
    });
    installLoaderReadSetSink(recordLoaderReadSet);
    resetRuntimeProfile();
  });

  // The read-set index is process-global state: a later suite in the same bun
  // process reading it (`_debug`, a capture assert) would otherwise see these
  // keys' tables. Remove what this describe recorded.
  afterAll(() => {
    const index = getReadSetIndex();
    const mine = ["doc-order-paths-probe"];
    const others = Object.keys(index).filter((k) => !mine.includes(k));
    for (const table of new Set(mine.flatMap((k) => index[k] ?? []))) {
      removeReadSetTable(table, others);
    }
  });

  test("pages.tree routes every page_blocks column its rows read", () => {
    const { routes } = compileCollection(pagesTree, pageRowsServeOptions).all
      .routes;
    const blocks = routes.filter((r) => r.table === "page_blocks");
    expect(blocks.length).toBeGreaterThan(0);
    const columns = new Set(blocks.flatMap((r) => r.columns));
    // Membership (`type`, `deleted_at`), the order (`created_at`), the stored
    // document-order key and the payload a rename / icon / kind write moves.
    for (const column of [
      "type",
      "deleted_at",
      "created_at",
      "doc_rank",
      "data",
    ]) {
      expect(columns).toContain(column);
    }
    // The trash correlation is read by no field: a write of it alone routes
    // nowhere.
    expect(columns).not.toContain("trash_entry_id");
    // Routed, not read-set driven: the key never enters the legacy index.
    expect(getReadSetIndex()[pagesTree.key]).toBeUndefined();
  });

  // That CTE is no live-state loader, but the same quoting rule decides
  // whether any loader built on it keeps its edge — this pins it in
  // isolation, failing if `${_blocks}` is ever "simplified" to a bare
  // `page_blocks`.
  test("docOrderPaths' raw CTE names the table quotably on its own", async () => {
    await recordEntrySpan("loader", "doc-order-paths-probe", () =>
      docOrderPaths(),
    );
    expect(getReadSetIndex()["doc-order-paths-probe"]).toContain("page_blocks");
  });
});
