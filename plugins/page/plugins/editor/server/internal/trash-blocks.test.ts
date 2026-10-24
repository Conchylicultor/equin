/**
 * Real-DB suite for the block trash chokepoint: `deleteBlocksSubtree`,
 * `untrashBlocks`, `purgeTrashedBlocks`. Headless — drives the db-parametrized
 * functions against a throwaway Postgres (db-test-fixture) with the REAL migration
 * chain, so the `page_blocks` self-FK cascades, the partial unique indexes and
 * the trash-flags CHECK are exactly what production applies. Fake lifecycle
 * hooks (registered via `collectContributions`) stand in for the search /
 * history / links consumers.
 *
 * Every test ends with the ledger invariant asserted: an entry exists ⇔ at
 * least one row carries its id.
 *
 * Run: `./equin test plugins/page/plugins/editor`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { TrashEntrySchema } from "@plugins/infra/plugins/trash/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import { defineBlock, textBlockSchema } from "../../core";
import {
  pageBlockHandle,
  PAGES_TRASH_SOURCE,
  PAGE_BLOCKS_TRASH_SOURCE,
} from "../../core/schemas";
import { _blocks } from "./tables";
import { liveBlocks } from "./live-blocks";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle } from "./document-hooks";
import { applyPageBlockPatch } from "./handle-patch-blocks";
import {
  deleteBlocksSubtree,
  untrashBlocks,
  purgeTrashedBlocks,
} from "./trash-blocks";

// Stand-in for the `page/text` block type the seeds use (see the note in
// `beforeAll`). Text-bearing, so a `page-blocks` entry has a first line to be
// labelled from.
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

let t: TestDb;

const trashCalls: string[][] = [];
const restoreCalls: string[][] = [];
const onDeleteCalls: string[][] = [];

beforeAll(async () => {
  t = await createTestDb({ prefix: "trash_blocks_test" });
  await runMigrations(t.db);

  // Fake consumer hooks. OnDelete mimics the history hook: it reads the page ids
  // straight off the handed ROWS (no DB round-trip — the point of the rows-not-ids
  // contract) and drops their `entity_versions` from an after-commit callback,
  // the only place versions are destroyed. Trash NEVER runs OnDelete, so this
  // fake is exactly what proves "versions survive trash, die at purge".
  //
  // The block-data handles the seeds need are registered here too: `page` is this
  // plugin's own handle (the real one), while `text` is a throwaway stub — the
  // concrete text block lives in `page/text`, which imports this plugin, so
  // importing it back would be a cycle. `seedBlock` only needs the type to resolve.
  collectContributions([
    {
      id: "trash-blocks-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        BlockLifecycle.OnTrash({
          onTrash: (rows) => {
            trashCalls.push(rows.map((r) => r.id));
          },
        }),
        BlockLifecycle.OnRestore({
          onRestore: (rows) => {
            restoreCalls.push(rows.map((r) => r.id));
          },
        }),
        BlockLifecycle.OnDelete({
          onDelete: (rows) => {
            const ids = rows.map((r) => r.id);
            onDeleteCalls.push(ids);
            if (ids.length === 0) return;
            return async () => {
              await t.db.execute(
                sql`DELETE FROM entity_versions WHERE source_id = 'pages' AND entity_id IN (${sql.join(
                  ids.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
              );
            };
          },
        }),
      ],
    },
  ]);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  trashCalls.length = 0;
  restoreCalls.length = 0;
  onDeleteCalls.length = 0;
  // A clean slate per test (order-independent).
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM entity_versions`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

afterEach(async () => {
  await expectLedgerConsistent();
});

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedBlock(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
  title?: string;
  text?: string;
}): Promise<void> {
  await t.db.insert(_blocks).values({
    id: args.id,
    parentId: args.parentId,
    pageId: args.pageId,
    type: args.type,
    rank: args.rank,
    data: parseBlockData(
      args.type,
      args.type === "page"
        ? { title: args.title ?? args.id, icon: null }
        : { text: args.text ?? "" },
    ),
  });
}

async function seedDoc(blockId: string): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO page_block_docs (block_id, state) VALUES (${blockId}, decode('00', 'hex'))`,
  );
}

async function seedVersion(entityId: string): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO entity_versions (id, source_id, entity_id, snapshot)
        VALUES (${`v-${entityId}-${Math.random()}`}, 'pages', ${entityId}, '{}'::jsonb)`,
  );
}

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  return r;
}

async function countDocs(blockId: string): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM page_block_docs WHERE block_id = ${blockId}`,
  );
  return res.rows[0]!.n;
}

async function countVersions(entityId: string): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM entity_versions WHERE entity_id = ${entityId}`,
  );
  return res.rows[0]!.n;
}

async function entries() {
  return t.db.select().from(_trashEntries);
}

async function onlyEntry() {
  const all = await entries();
  expect(all).toHaveLength(1);
  return TrashEntrySchema.parse(all[0]);
}

/**
 * The ledger invariant, both directions: every entry is carried by ≥1 row, and
 * every flagged row names an existing entry. (The CHECK already guarantees the
 * two flags agree on each row.)
 */
async function expectLedgerConsistent(): Promise<void> {
  const orphanEntries = await t.db.execute<{ id: string }>(
    sql`SELECT e.id FROM trash_entries e
        WHERE NOT EXISTS (SELECT 1 FROM page_blocks b WHERE b.trash_entry_id = e.id)`,
  );
  expect(orphanEntries.rows).toEqual([]);
  const danglingRows = await t.db.execute<{ id: string }>(
    sql`SELECT b.id FROM page_blocks b
        WHERE b.trash_entry_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM trash_entries e WHERE e.id = b.trash_entry_id)`,
  );
  expect(danglingRows.rows).toEqual([]);
}

/**
 * The incident shape: a workspace page W containing two sub-pages A and B, A
 * itself containing a sub-sub-page A2. Each page has a content text block with a
 * CRDT doc and a version row.
 */
async function seedIncident(): Promise<void> {
  await seedBlock({
    id: "W",
    parentId: null,
    pageId: null,
    type: "page",
    rank: "a0",
  });
  // A: sub-page in W's content, with content A1 + a sub-sub-page A2.
  await seedBlock({
    id: "A",
    parentId: "W",
    pageId: "W",
    type: "page",
    rank: "a0",
  });
  await seedBlock({
    id: "A1",
    parentId: "A",
    pageId: "A",
    type: "text",
    rank: "a0",
  });
  await seedBlock({
    id: "A2",
    parentId: "A",
    pageId: "A",
    type: "page",
    rank: "a1",
  });
  await seedBlock({
    id: "A2a",
    parentId: "A2",
    pageId: "A2",
    type: "text",
    rank: "a0",
  });
  // B: sub-page in W's content, with content B1.
  await seedBlock({
    id: "B",
    parentId: "W",
    pageId: "W",
    type: "page",
    rank: "a1",
  });
  await seedBlock({
    id: "B1",
    parentId: "B",
    pageId: "B",
    type: "text",
    rank: "a0",
  });
  for (const id of ["A1", "A2a", "B1"]) await seedDoc(id);
  for (const id of ["A", "A2", "B"]) await seedVersion(id);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("deleteBlocksSubtree — page roots (incident shape)", () => {
  test("bulk-deleting two sub-pages trashes both subtrees, one entry each; docs + versions survive", async () => {
    await seedIncident();

    const result = await deleteBlocksSubtree(["A", "B"], t.db);
    expect(result.trashed).toBe(true);

    // Two independently-restorable entries, one per page ROOT.
    const all = await entries();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.rootEntityId))).toEqual(
      new Set(["A", "B"]),
    );
    expect(all.every((e) => e.sourceId === PAGES_TRASH_SOURCE)).toBe(true);
    const entryA = all.find((e) => e.rootEntityId === "A")!;
    const entryB = all.find((e) => e.rootEntityId === "B")!;

    // The chokepoint RETURNS the entries it minted, in creation order (root
    // order), each with its source — the ledger handles an undoable delete
    // restores with.
    expect(result.trashed ? result.entries : []).toEqual([
      { sourceId: PAGES_TRASH_SOURCE, entryId: entryA.id },
      { sourceId: PAGES_TRASH_SOURCE, entryId: entryB.id },
    ]);

    // Every descendant row — INCLUDING cross-`page_id` content — is flagged, under
    // the correct entry.
    for (const id of ["A", "A1", "A2", "A2a"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(entryA.id);
    }
    for (const id of ["B", "B1"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(entryB.id);
    }
    // The container W is untouched.
    expect((await row("W"))?.deletedAt).toBeNull();

    // The CRDT docs and version history SURVIVE (no cascade fired).
    expect(await countDocs("A1")).toBe(1);
    expect(await countDocs("A2a")).toBe(1);
    expect(await countDocs("B1")).toBe(1);
    expect(await countVersions("A")).toBe(1);
    expect(await countVersions("A2")).toBe(1);
    expect(await countVersions("B")).toBe(1);

    // OnTrash fired with the full set; OnDelete (the version killer) did NOT.
    expect(onDeleteCalls).toHaveLength(0);
    expect(trashCalls.flat().sort()).toEqual([
      "A",
      "A1",
      "A2",
      "A2a",
      "B",
      "B1",
    ]);
  });

  test("a page nested under a deleted NON-page root anchors a `pages` entry on that root", async () => {
    // W ▸ toggle-ish text T ▸ sub-page S. Deleting T must keep S findable in
    // the Pages Trash, so the anchor entry is a `pages` one labelled by S.
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "T",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a0",
      text: "toggle",
    });
    await seedBlock({
      id: "S",
      parentId: "T",
      pageId: "W",
      type: "page",
      rank: "a0",
      title: "Nested",
    });
    await seedBlock({
      id: "S1",
      parentId: "S",
      pageId: "S",
      type: "text",
      rank: "a0",
    });

    const result = await deleteBlocksSubtree(["T"], t.db);
    const entry = await onlyEntry();
    expect(entry.sourceId).toBe(PAGES_TRASH_SOURCE);
    expect(entry.rootEntityId).toBe("T");
    expect(entry.label).toBe("Nested");
    expect(result).toEqual({
      trashed: true,
      entries: [{ sourceId: PAGES_TRASH_SOURCE, entryId: entry.id }],
    });
    for (const id of ["T", "S", "S1"]) {
      expect((await row(id))?.trashEntryId).toBe(entry.id);
    }
  });
});

describe("deleteBlocksSubtree — every delete is a trash", () => {
  test("a page-free delete set is trashed under ONE `page-blocks` entry (rows kept, docs intact, no OnDelete)", async () => {
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
      text: "  first line\nsecond line",
    });
    await seedBlock({
      id: "c1a",
      parentId: "c1",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await seedDoc("c1");
    await seedDoc("c1a");

    const result = await deleteBlocksSubtree(["c1"], t.db);

    const entry = await onlyEntry();
    expect(entry.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    expect(entry.rootEntityId).toBe("c1");
    // Labelled by the root's first non-empty line, trimmed.
    expect(entry.label).toBe("first line");
    expect(entry.meta).toEqual({ pageId: "P", rootIds: ["c1"], count: 2 });
    expect(result).toEqual({
      trashed: true,
      entries: [{ sourceId: PAGE_BLOCKS_TRASH_SOURCE, entryId: entry.id }],
    });

    // Rows survive, flagged under the entry; the docs are untouched.
    for (const id of ["c1", "c1a"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(entry.id);
      expect(await countDocs(id)).toBe(1);
    }
    expect((await row("P"))?.deletedAt).toBeNull();

    // OnTrash saw the full set; OnDelete never fired.
    expect(trashCalls).toEqual([expect.arrayContaining(["c1", "c1a"])]);
    expect(trashCalls[0]).toHaveLength(2);
    expect(onDeleteCalls).toHaveLength(0);
  });

  test("an empty-text root is labelled by its row count", async () => {
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
      text: "",
    });
    await seedBlock({
      id: "c2",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a1",
      text: "",
    });
    await deleteBlocksSubtree(["c1", "c2"], t.db);
    const entry = await onlyEntry();
    expect(entry.label).toBe("2 blocks");
    expect(entry.meta).toEqual({
      pageId: "P",
      rootIds: ["c1", "c2"],
      count: 2,
    });
  });

  test("a long first line is cut to 80 characters", async () => {
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
      text: "x".repeat(200),
    });
    await deleteBlocksSubtree(["c1"], t.db);
    const entry = await onlyEntry();
    expect(entry.label).toHaveLength(80);
    expect(entry.label.endsWith("…")).toBe(true);
  });

  test("deleting an already-trashed id trashes nothing and mints no entry", async () => {
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await deleteBlocksSubtree(["c1"], t.db);
    const first = await onlyEntry();

    const again = await deleteBlocksSubtree(["c1"], t.db);
    expect(again).toEqual({ trashed: false });
    expect(await entries()).toHaveLength(1);
    expect((await row("c1"))?.trashEntryId).toBe(first.id);
  });

  test("the CHECK rejects a row flagged without an entry (and vice versa)", async () => {
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
    });

    const flagOnly = await t.db
      .execute(sql`UPDATE page_blocks SET deleted_at = now() WHERE id = 'c1'`)
      .catch((e: unknown) => e);
    expect(String(flagOnly)).toContain("page_blocks_trash_flags_agree");

    const entryOnly = await t.db
      .execute(
        sql`UPDATE page_blocks SET trash_entry_id = 'ghost' WHERE id = 'c1'`,
      )
      .catch((e: unknown) => e);
    expect(String(entryOnly)).toContain("page_blocks_trash_flags_agree");

    expect((await row("c1"))?.deletedAt).toBeNull();
  });
});

describe("untrashBlocks", () => {
  test("restores exactly the entry's rows, consumes the entry, leaves a separately-trashed page alone", async () => {
    await seedIncident();
    await deleteBlocksSubtree(["A", "B"], t.db);
    const entryA = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "A"))
      )[0],
    );

    const outcome = await untrashBlocks(entryA, t.db);
    expect(outcome.restoredIds.sort()).toEqual(["A", "A1", "A2", "A2a"]);

    for (const id of ["A", "A1", "A2", "A2a"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeNull();
      expect(r?.trashEntryId).toBeNull();
    }
    // B's entry is untouched; A's entry is consumed.
    expect((await row("B"))?.deletedAt).toBeInstanceOf(Date);
    const remaining = await entries();
    expect(remaining.map((e) => e.rootEntityId)).toEqual(["B"]);
    expect(restoreCalls.flat().sort()).toEqual(["A", "A1", "A2", "A2a"]);
  });

  test("a taken rank slot: the restored root lands right AFTER the occupant, not at the end", async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "B",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a1",
    });
    await seedBlock({
      id: "C",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a2",
    });

    await deleteBlocksSubtree(["B"], t.db);
    const entryB = await onlyEntry();

    // While B is trashed, a live sibling claims B's old slot (partial index
    // allows it — B is excluded).
    await seedBlock({
      id: "D",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a1",
    });

    await untrashBlocks(entryB, t.db);

    const restored = await row("B");
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.rank).not.toBe("a1"); // re-ranked off the collision
    // B sits between the occupant D and C — where it was — with no unique
    // violation.
    const live = await t.db
      .select({ id: _blocks.id, rank: _blocks.rank })
      .from(_blocks)
      .where(and(eq(_blocks.parentId, "W"), isNull(_blocks.deletedAt)));
    const order = live
      .sort((x, y) => (x.rank < y.rank ? -1 : 1))
      .map((r) => r.id);
    expect(order).toEqual(["A", "D", "B", "C"]);
  });

  test("a restored root whose parent has vanished is reparented to the workspace root", async () => {
    // W → A → B (B nested under sub-page A). Trash B, then trash A. Restoring B
    // finds its parent A still trashed → reparent to root.
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "B",
      parentId: "A",
      pageId: "A",
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "B1",
      parentId: "B",
      pageId: "B",
      type: "text",
      rank: "a0",
    });

    await deleteBlocksSubtree(["B"], t.db); // entryB flags {B, B1}
    await deleteBlocksSubtree(["A"], t.db); // entryA flags {A} only (B already trashed)

    const entryB = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "B"))
      )[0],
    );
    await untrashBlocks(entryB, t.db);

    const b = await row("B");
    expect(b?.deletedAt).toBeNull();
    expect(b?.parentId).toBeNull(); // reparented to workspace root
    expect(b?.pageId).toBeNull(); // now a root page
    // Its own content survived and is still scoped to B.
    expect((await row("B1"))?.deletedAt).toBeNull();
    expect((await row("B1"))?.pageId).toBe("B");
    // The OnRestore rows carry the RESTORED parentage.
    expect(restoreCalls).toHaveLength(1);
  });

  test("a restored NON-page root whose container has vanished lands at the END of its page's top level, children attached", async () => {
    // W (page) holds A and a container T; T holds X; X holds X1. X is deleted,
    // THEN its container T; X's entry is restored before T's (a second tab, an
    // agent, the page-blocks trash). X must come back INSIDE W — never at the
    // workspace root as a page-less content row no `liveBlocks WHERE page_id`
    // read would return.
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "T",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a1",
    });
    await seedBlock({
      id: "X",
      parentId: "T",
      pageId: "W",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "X1",
      parentId: "X",
      pageId: "W",
      type: "text",
      rank: "a0",
    });

    await deleteBlocksSubtree(["X"], t.db); // entryX flags {X, X1}
    await deleteBlocksSubtree(["T"], t.db); // entryT flags {T} only
    const entryX = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "X"))
      )[0],
    );

    const outcome = await untrashBlocks(entryX, t.db);
    expect(outcome.restoredIds.sort()).toEqual(["X", "X1"]);

    const x = await row("X");
    expect(x?.deletedAt).toBeNull();
    expect(x?.parentId).toBe("W"); // its own page's top level…
    expect(x?.pageId).toBe("W"); // …still in that page
    // X1 came back with it, still hanging off X, still in W.
    const x1 = await row("X1");
    expect(x1?.deletedAt).toBeNull();
    expect(x1?.parentId).toBe("X");
    expect(x1?.pageId).toBe("W");
    // Visible through the live read every page consumer uses.
    const liveInW = await t.db
      .select({ id: liveBlocks.id })
      .from(liveBlocks)
      .where(eq(liveBlocks.pageId, "W"));
    expect(liveInW.map((r) => r.id).sort()).toEqual(["A", "X", "X1"]);
    // At the END of the top level (after A; the trashed T keeps its slot).
    const topLevelOrder = async () =>
      (
        await t.db
          .select({ id: _blocks.id, rank: _blocks.rank })
          .from(_blocks)
          .where(and(eq(_blocks.parentId, "W"), isNull(_blocks.deletedAt)))
      )
        .sort((p, q) => (p.rank < q.rank ? -1 : 1))
        .map((r) => r.id);
    expect(await topLevelOrder()).toEqual(["A", "X"]);
    expect(restoreCalls).toHaveLength(1);

    // Now the container: it comes back into its own untouched slot, so both
    // are live and X keeps its place after it.
    const entryT = await onlyEntry();
    await untrashBlocks(entryT, t.db);
    expect((await row("T"))?.deletedAt).toBeNull();
    expect((await row("T"))?.parentId).toBe("W");
    expect(await topLevelOrder()).toEqual(["A", "T", "X"]);
    expect(await entries()).toHaveLength(0);

    // Redo of the restored child (the undo stack's forward patch names it in
    // `deleteIds`): trashes X and X1 again, under ONE fresh page-blocks entry,
    // from their new position — T stays live.
    await applyPageBlockPatch(
      "W",
      { creates: [], updates: [], deleteIds: ["X"] },
      t.db,
    );
    const redone = await onlyEntry();
    expect(redone.id).not.toBe(entryX.id);
    expect(redone.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    for (const id of ["X", "X1"]) {
      expect((await row(id))?.trashEntryId).toBe(redone.id);
    }
    expect((await row("T"))?.deletedAt).toBeNull();
    expect(await topLevelOrder()).toEqual(["A", "T"]);
  });

  test("a NON-page root cannot be restored into a trashed page: loud, and nothing moves", async () => {
    // W → P (page) → T → X. X deleted, then T, then the page P. Restoring X
    // would leave a live row under a trashed page (unreachable, yet reindexed
    // for search by OnRestore), so it refuses: restore the page first.
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "P",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "T",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "X",
      parentId: "T",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await deleteBlocksSubtree(["X"], t.db);
    await deleteBlocksSubtree(["T"], t.db);
    await deleteBlocksSubtree(["P"], t.db);
    const entryX = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "X"))
      )[0],
    );

    // Same shape as doc-store.test.ts: bun's `expect(...).rejects` is not a
    // thenable in its typings, so the rejection is caught by hand.
    let caught: unknown;
    try {
      await untrashBlocks(entryX, t.db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/page P is in the trash/);
    // The transaction rolled back: X is still trashed under its entry, nothing
    // else changed, no OnRestore fired.
    expect((await row("X"))?.trashEntryId).toBe(entryX.id);
    expect((await row("P"))?.deletedAt).toBeInstanceOf(Date);
    expect(await entries()).toHaveLength(3);
    expect(restoreCalls).toHaveLength(0);

    // Restore the page, and X can come back (into P's top level).
    const entryP = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "P"))
      )[0],
    );
    await untrashBlocks(entryP, t.db);
    await untrashBlocks(entryX, t.db);
    const x = await row("X");
    expect(x?.deletedAt).toBeNull();
    expect(x?.parentId).toBe("P");
    expect(x?.pageId).toBe("P");
  });
});

describe("purgeTrashedBlocks", () => {
  test("hard-deletes the roots + cascade, runs OnDelete (versions die only here)", async () => {
    await seedIncident();
    await deleteBlocksSubtree(["A", "B"], t.db);

    // Versions still there after trash.
    expect(await countVersions("A")).toBe(1);
    expect(await countVersions("A2")).toBe(1);

    const entryA = TrashEntrySchema.parse(
      (
        await t.db
          .select()
          .from(_trashEntries)
          .where(eq(_trashEntries.rootEntityId, "A"))
      )[0],
    );
    await purgeTrashedBlocks([entryA], t.db);
    // The primitive's lifecycle deletes the ledger row after purge; mirror it.
    await t.db.delete(_trashEntries).where(eq(_trashEntries.id, entryA.id));

    // A's whole subtree is hard-gone (cascade), including cross-page content + docs.
    for (const id of ["A", "A1", "A2", "A2a"]) {
      expect(await row(id)).toBeUndefined();
    }
    expect(await countDocs("A1")).toBe(0);
    expect(await countDocs("A2a")).toBe(0);
    // OnDelete fired over the full cascade set → versions destroyed at purge.
    expect(onDeleteCalls.flat().sort()).toEqual(["A", "A1", "A2", "A2a"]);
    expect(await countVersions("A")).toBe(0);
    expect(await countVersions("A2")).toBe(0);

    // B (a different entry) is untouched by this purge.
    expect((await row("B"))?.deletedAt).toBeInstanceOf(Date);
    expect(await countVersions("B")).toBe(1);
  });

  test("a batch of entries from BOTH sources purges in one pass; a gone entry is skipped (idempotent)", async () => {
    await seedIncident();
    await seedBlock({
      id: "W1",
      parentId: "W",
      pageId: "W",
      type: "text",
      rank: "a2",
    });
    await seedDoc("W1");
    await deleteBlocksSubtree(["A"], t.db); // pages entry
    await deleteBlocksSubtree(["W1"], t.db); // page-blocks entry
    const all = (await entries()).map((e) => TrashEntrySchema.parse(e));
    expect(new Set(all.map((e) => e.sourceId))).toEqual(
      new Set([PAGES_TRASH_SOURCE, PAGE_BLOCKS_TRASH_SOURCE]),
    );

    await purgeTrashedBlocks(all, t.db);
    await t.db.delete(_trashEntries);

    for (const id of ["A", "A1", "A2", "A2a", "W1"]) {
      expect(await row(id)).toBeUndefined();
    }
    expect(await countDocs("W1")).toBe(0);
    // One OnDelete dispatch over the whole batch.
    expect(onDeleteCalls).toHaveLength(1);
    expect(onDeleteCalls[0]!.sort()).toEqual(["A", "A1", "A2", "A2a", "W1"]);

    onDeleteCalls.length = 0;
    // Second purge: nothing flagged → skipped.
    await purgeTrashedBlocks(all, t.db);
    expect(onDeleteCalls).toHaveLength(0);
  });
});

describe("re-trash (redo symmetry)", () => {
  test("trash → restore → trash mints a fresh entry each time, and restore consumed the first", async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a0",
    });

    await deleteBlocksSubtree(["A"], t.db);
    const first = await onlyEntry();
    await untrashBlocks(first, t.db);
    // The restore consumed its own entry — no caller has to delete it.
    expect(await entries()).toHaveLength(0);

    await deleteBlocksSubtree(["A"], t.db);
    const flagged = await t.db
      .select()
      .from(_blocks)
      .where(isNotNull(_blocks.deletedAt));
    expect(flagged).toHaveLength(1);
    const second = await onlyEntry();
    expect(second.id).not.toBe(first.id);
  });
});
