/**
 * Real-DB suite for the patch handler's trash symmetry — `applyPageBlockPatch`
 * driven headlessly against a throwaway Postgres (db-test-fixture) with the REAL
 * migration chain, so the self-FK cascades, the partial unique indexes and the
 * trash-flags CHECK are exactly what production applies.
 *
 * What it pins (research/2026-09-09-page-data-based-text-undo-entries-v2.md §3):
 *  - a `create` whose id is TRASHED restores its whole entry (the stored row,
 *    `created_at` and the content doc all byte-identical) and consumes it;
 *  - a redo (`deleteIds`) re-trashes under a NEW entry, closed under descendants;
 *  - a mixed page + paragraph delete is one `pages` entry, and one undo;
 *  - purge cascades docs and attachment links, and is idempotent;
 *  - a restored root whose slot was taken lands after the occupant;
 *  - every test ends with the ledger invariant asserted.
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
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { TrashEntrySchema } from "@plugins/infra/plugins/trash/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { defineBlock, textBlockSchema, type Block } from "../../core";
import {
  pageBlockHandle,
  PAGES_TRASH_SOURCE,
  PAGE_BLOCKS_TRASH_SOURCE,
} from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle } from "./document-hooks";
import { applyPageBlockPatch } from "./handle-patch-blocks";
import { deleteBlocksSubtree, purgeTrashedBlocks } from "./trash-blocks";
import { withPageForest } from "./page-forest";
import { writeForestTarget } from "./forest-writer";
import { rowToNode } from "./reconcile";

// Stand-in for `page/text` (the concrete block plugin imports this one, so
// importing it back would be a cycle). Text-bearing, so `data.text` is real.
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
  t = await createTestDb({ prefix: "patch_blocks_test" });
  await runMigrations(t.db);
  collectContributions([
    {
      id: "handle-patch-blocks-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        BlockLifecycle.OnTrash({
          onTrash: (rows) => {
            trashCalls.push(rows.map((r) => r.id).sort());
          },
        }),
        BlockLifecycle.OnRestore({
          onRestore: (rows) => {
            restoreCalls.push(rows.map((r) => r.id).sort());
          },
        }),
        BlockLifecycle.OnDelete({
          onDelete: (rows) => {
            onDeleteCalls.push(rows.map((r) => r.id).sort());
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
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM attachments`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

afterEach(async () => {
  await expectLedgerConsistent();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedBlock(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
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
        ? { title: args.id, icon: null }
        : { text: args.text ?? "" },
    ),
  });
}

/** A content doc with DISTINCT bytes per block, so byte identity is a real check. */
async function seedDoc(blockId: string, hex: string): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO page_block_docs (block_id, state) VALUES (${blockId}, decode(${hex}, 'hex'))`,
  );
}

async function docHex(blockId: string): Promise<string | undefined> {
  const res = await t.db.execute<{ hex: string }>(
    sql`SELECT encode(state, 'hex') AS hex FROM page_block_docs WHERE block_id = ${blockId}`,
  );
  return res.rows[0]?.hex;
}

async function seedAttachmentLink(
  blockId: string,
  attachmentId: string,
): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO attachments (id, filename, mime, size, disk_path)
        VALUES (${attachmentId}, 'f.png', 'image/png', 1, ${`/tmp/${attachmentId}`})`,
  );
  await t.db.execute(
    sql`INSERT INTO page_blocks_attachments (owner_id, attachment_id) VALUES (${blockId}, ${attachmentId})`,
  );
}

async function countLinks(blockId: string): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM page_blocks_attachments WHERE owner_id = ${blockId}`,
  );
  return res.rows[0]!.n;
}

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  return r;
}

async function entries() {
  return t.db.select().from(_trashEntries);
}

async function onlyEntry() {
  const all = await entries();
  expect(all).toHaveLength(1);
  return TrashEntrySchema.parse(all[0]);
}

/** Live child ids under `parentId`, in rank order. */
async function liveChildren(parentId: string): Promise<string[]> {
  const rows = await t.db
    .select({ id: _blocks.id, rank: _blocks.rank })
    .from(_blocks)
    .where(and(eq(_blocks.parentId, parentId), isNull(_blocks.deletedAt)));
  return rows.sort((x, y) => (x.rank < y.rank ? -1 : 1)).map((r) => r.id);
}

/** The `Block` a client would put in `creates` for an undo-of-delete. */
function blockOf(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
  text?: string;
}): Block {
  return {
    id: args.id,
    parentId: args.parentId,
    pageId: args.pageId,
    type: args.type,
    data:
      args.type === "page"
        ? { title: args.id, icon: null }
        : { text: [{ text: args.text ?? "" }] },
    rank: Rank.from(args.rank),
    expanded: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** The ledger invariant, both directions. */
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

/** P ▸ [c1 "hello" ▸ [c1a "child"], c2 "two"] with distinct docs on c1 / c1a. */
async function seedPage(): Promise<void> {
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
    text: "hello",
  });
  await seedBlock({
    id: "c1a",
    parentId: "c1",
    pageId: "P",
    type: "text",
    rank: "a0",
    text: "child",
  });
  await seedBlock({
    id: "c2",
    parentId: "P",
    pageId: "P",
    type: "text",
    rank: "a1",
    text: "two",
  });
  await seedDoc("c1", "c1c1");
  await seedDoc("c1a", "c1a0");
}

const patch = (p: Partial<Parameters<typeof applyPageBlockPatch>[1]>) =>
  applyPageBlockPatch(
    "P",
    { creates: [], updates: [], deleteIds: [], ...p },
    t.db,
  );

// ── Tests ──────────────────────────────────────────────────────────────────

describe("applyPageBlockPatch — un-trash on create", () => {
  test("a create on a trashed id restores its WHOLE entry byte-exact and consumes it", async () => {
    await seedPage();
    const before = await row("c1");
    await deleteBlocksSubtree(["c1"], t.db);
    const entry = await onlyEntry();
    expect(entry.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    trashCalls.length = 0;

    // The undo patch re-creates the root with a STALE `data.text` (the client
    // pinned what it had); the restore must keep the stored row instead.
    const { blocks } = await patch({
      creates: [
        blockOf({
          id: "c1",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a0",
          text: "stale",
        }),
      ],
    });

    const c1 = await row("c1");
    expect(c1?.deletedAt).toBeNull();
    expect(c1?.trashEntryId).toBeNull();
    // The stored row came back as it was: same creation instant, same data.
    expect(c1?.createdAt.getTime()).toBe(before!.createdAt.getTime());
    expect(c1?.data).toEqual(before!.data);
    // The descendant came back with it (the entry is restored whole)…
    expect((await row("c1a"))?.deletedAt).toBeNull();
    // …and the content docs are byte-identical to what was trashed.
    expect(await docHex("c1")).toBe("c1c1");
    expect(await docHex("c1a")).toBe("c1a0");
    // The entry was consumed by the restore.
    expect(await entries()).toHaveLength(0);
    expect(restoreCalls).toEqual([["c1", "c1a"]]);
    // The handler answers with the live page.
    expect(blocks.map((b) => b.id).sort()).toEqual(["c1", "c1a", "c2"]);
  });

  test("redo re-trashes under a NEW entry, closed under descendants", async () => {
    await seedPage();
    await deleteBlocksSubtree(["c1"], t.db);
    const first = await onlyEntry();
    await patch({
      creates: [
        blockOf({
          id: "c1",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a0",
        }),
      ],
    });
    expect(await entries()).toHaveLength(0);
    trashCalls.length = 0;

    // The redo names only the root; the writer closes the set over c1a.
    await patch({ deleteIds: ["c1"] });

    const second = await onlyEntry();
    expect(second.id).not.toBe(first.id);
    expect(second.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    expect(second.meta).toEqual({ pageId: "P", rootIds: ["c1"], count: 2 });
    for (const id of ["c1", "c1a"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(second.id);
    }
    expect(trashCalls).toEqual([["c1", "c1a"]]);
    expect(onDeleteCalls).toHaveLength(0);
    // Docs still intact — a redo is a trash too.
    expect(await docHex("c1")).toBe("c1c1");
    expect(await docHex("c1a")).toBe("c1a0");
  });

  test("a bulk undo whose creates share one entry restores it ONCE", async () => {
    await seedPage();
    await deleteBlocksSubtree(["c1", "c2"], t.db);
    const entry = await onlyEntry();
    expect(entry.meta).toEqual({
      pageId: "P",
      rootIds: ["c1", "c2"],
      count: 3,
    });

    await patch({
      creates: [
        blockOf({
          id: "c1",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a0",
        }),
        blockOf({
          id: "c2",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a1",
        }),
      ],
    });

    expect(await liveChildren("P")).toEqual(["c1", "c2"]);
    expect(await entries()).toHaveLength(0);
    expect(restoreCalls).toEqual([["c1", "c1a", "c2"]]);
  });
});

describe("applyPageBlockPatch — mixed page + paragraph delete", () => {
  test("one `pages` entry for the gesture; one undo brings everything back", async () => {
    await seedPage();
    await seedBlock({
      id: "SUB",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a2",
    });
    await seedBlock({
      id: "SUB1",
      parentId: "SUB",
      pageId: "SUB",
      type: "text",
      rank: "a0",
      text: "sub",
    });
    await seedDoc("SUB1", "5b01");

    await patch({ deleteIds: ["c1", "SUB"] });

    // Deferred to the chokepoint: SUB mints a `pages` entry and c1's subtree
    // folds into it — one entry, one undo.
    const entry = await onlyEntry();
    expect(entry.sourceId).toBe(PAGES_TRASH_SOURCE);
    expect(entry.rootEntityId).toBe("SUB");
    for (const id of ["c1", "c1a", "SUB", "SUB1"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(entry.id);
    }
    expect((await row("c2"))?.deletedAt).toBeNull();
    expect(trashCalls).toEqual([["SUB", "SUB1", "c1", "c1a"]]);

    // Undo: the client re-creates both roots; the shared entry restores once.
    await patch({
      creates: [
        blockOf({
          id: "c1",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a0",
        }),
        blockOf({
          id: "SUB",
          parentId: "P",
          pageId: "P",
          type: "page",
          rank: "a2",
        }),
      ],
    });
    for (const id of ["c1", "c1a", "SUB", "SUB1"]) {
      expect((await row(id))?.deletedAt).toBeNull();
    }
    expect(await entries()).toHaveLength(0);
    expect(restoreCalls).toHaveLength(1);
    expect(await docHex("SUB1")).toBe("5b01");
  });
});

describe("applyPageBlockPatch — rank repair on restore", () => {
  test("a taken slot: the restored root lands after the occupant, with no unique violation", async () => {
    await seedPage();
    // P ▸ [c1 a0, c2 a1] — trash c2, then a new live sibling takes a1.
    await deleteBlocksSubtree(["c2"], t.db);
    await seedBlock({
      id: "c3",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a1",
    });
    await seedBlock({
      id: "c4",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a2",
    });

    await patch({
      creates: [
        blockOf({
          id: "c2",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a1",
        }),
      ],
    });

    const c2 = await row("c2");
    expect(c2?.deletedAt).toBeNull();
    expect(c2?.rank).not.toBe("a1");
    // Right after the occupant, where it was — not appended at the end.
    expect(await liveChildren("P")).toEqual(["c1", "c3", "c2", "c4"]);
  });
});

describe("purgeTrashedBlocks", () => {
  test("cascades the docs and attachment links a trash left alone; idempotent", async () => {
    await seedPage();
    await seedAttachmentLink("c1", "att-1");

    await deleteBlocksSubtree(["c1"], t.db);
    // A trash touches neither the doc nor the link: the orphan sweep keeps the file.
    expect(await docHex("c1")).toBe("c1c1");
    expect(await countLinks("c1")).toBe(1);
    const entry = await onlyEntry();

    await purgeTrashedBlocks([entry], t.db);
    // The primitive's lifecycle deletes the ledger row after purge; mirror it.
    await t.db.delete(_trashEntries).where(eq(_trashEntries.id, entry.id));

    expect(await row("c1")).toBeUndefined();
    expect(await row("c1a")).toBeUndefined();
    expect(await docHex("c1")).toBeUndefined();
    expect(await docHex("c1a")).toBeUndefined();
    expect(await countLinks("c1")).toBe(0);
    expect(onDeleteCalls).toEqual([["c1", "c1a"]]);

    onDeleteCalls.length = 0;
    await purgeTrashedBlocks([entry], t.db);
    expect(onDeleteCalls).toHaveLength(0);
  });
});

describe("applyPageBlockPatch — the delete set follows the forest as written", () => {
  test("a child the patch re-parents OUT of a deleted parent stays live", async () => {
    await seedPage();

    // The redo of an unwrap: c1a leaves c1 for c1's slot, and c1 goes.
    await patch({
      updates: [
        {
          id: "c1a",
          changes: { parentId: "P", rank: Rank.from("a0V") },
        },
      ],
      deleteIds: ["c1"],
    });

    expect(await liveChildren("P")).toEqual(["c1a", "c2"]);
    const c1a = await row("c1a");
    expect(c1a?.deletedAt).toBeNull();
    expect(c1a?.parentId).toBe("P");
    expect(await docHex("c1a")).toBe("c1a0");
    // Only c1 was trashed, under one entry naming it alone.
    const entry = await onlyEntry();
    expect(entry.meta).toEqual({ pageId: "P", rootIds: ["c1"], count: 1 });
    expect((await row("c1"))?.trashEntryId).toBe(entry.id);
    expect(trashCalls).toEqual([["c1"]]);
  });

  test("a row may take the exact (parent, rank) slot of a row the same patch deletes", async () => {
    await seedPage();

    // c1 holds (P, a0); c2 moves onto exactly that pair as c1 goes. The live
    // unique index is partial on `deleted_at IS NULL`, so the trash has to land
    // first for the slot to be free.
    await patch({
      updates: [{ id: "c2", changes: { rank: Rank.from("a0") } }],
      deleteIds: ["c1"],
    });

    expect(await liveChildren("P")).toEqual(["c2"]);
    expect((await row("c2"))?.rank).toBe("a0");
    const entry = await onlyEntry();
    expect(entry.meta).toEqual({ pageId: "P", rootIds: ["c1"], count: 2 });
    for (const id of ["c1", "c1a"]) {
      expect((await row(id))?.trashEntryId).toBe(entry.id);
    }
  });

  test("a patch naming one id both as a write and as a delete is a 400, and writes nothing", async () => {
    await seedPage();

    const viaUpdate = await patch({
      updates: [{ id: "c2", changes: { expanded: false } }],
      deleteIds: ["c2"],
    }).catch((e: unknown) => e);
    expect(viaUpdate).toBeInstanceOf(HttpError);
    expect((viaUpdate as HttpError).status).toBe(400);

    const viaCreate = await patch({
      creates: [
        blockOf({
          id: "c3",
          parentId: "P",
          pageId: "P",
          type: "text",
          rank: "a2",
        }),
      ],
      deleteIds: ["c3"],
    }).catch((e: unknown) => e);
    expect(viaCreate).toBeInstanceOf(HttpError);
    expect((viaCreate as HttpError).status).toBe(400);

    expect(await liveChildren("P")).toEqual(["c1", "c2"]);
    expect((await row("c2"))?.expanded).toBe(true);
    expect(await row("c3")).toBeUndefined();
    expect(await entries()).toHaveLength(0);
  });
});

describe("applyPageBlockPatch — blind-writer rules still hold", () => {
  test("an update naming a trashed row is a skip, never a resurrection", async () => {
    await seedPage();
    await deleteBlocksSubtree(["c2"], t.db);
    const entry = await onlyEntry();

    await patch({
      updates: [
        { id: "c2", changes: { data: { text: [{ text: "late flush" }] } } },
      ],
    });

    const c2 = await row("c2");
    expect(c2?.deletedAt).toBeInstanceOf(Date);
    expect(c2?.trashEntryId).toBe(entry.id);
    expect(await entries()).toHaveLength(1);
  });
});

// ── Pages a patch creates (research/2026-09-11-page-agent-pages.md §3) ──────

/** An agent-authored page's `data`. */
const agentData = (title: string) => ({
  title,
  icon: null,
  author: "agent" as const,
});

/** A page row a markdown apply mints: displayed in `pageId`, folded. */
function newPage(args: {
  id: string;
  parentId: string;
  pageId: string;
  rank: string;
}): Block {
  return {
    ...blockOf({ ...args, type: "page" }),
    data: agentData(args.id),
    expanded: false,
  };
}

/**
 * A row's stored `data`, widened to `unknown` so a test compares it against a
 * plain literal — the `BlockData` brand is for writers, and a reader needs none.
 */
async function storedData(id: string): Promise<unknown> {
  return (await row(id))?.data;
}

/** Await a write that must be refused with `status`, returning its message. */
async function refusedWith(
  write: Promise<unknown>,
  status: number,
): Promise<string> {
  try {
    await write;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    expect(err.status).toBe(status);
    return err.message;
  }
  throw new Error(`expected an HTTP ${status}`);
}

describe("applyPageBlockPatch — a page the patch creates", () => {
  test("a create spanning BOTH partitions lands, each row in its own", async () => {
    await seedPage();
    await patch({
      creates: [
        newPage({ id: "NEW", parentId: "P", pageId: "P", rank: "a5" }),
        blockOf({
          id: "NEW1",
          parentId: "NEW",
          pageId: "NEW",
          type: "text",
          rank: "a0",
          text: "first line",
        }),
        // Nested: a page minted inside the new page's body.
        newPage({ id: "NEW2", parentId: "NEW", pageId: "NEW", rank: "a1" }),
        blockOf({
          id: "NEW2a",
          parentId: "NEW2",
          pageId: "NEW2",
          type: "text",
          rank: "a0",
        }),
      ],
    });
    expect(await row("NEW")).toMatchObject({
      pageId: "P",
      parentId: "P",
      type: "page",
      data: agentData("NEW"),
    });
    expect(await row("NEW1")).toMatchObject({ pageId: "NEW", parentId: "NEW" });
    expect(await row("NEW2")).toMatchObject({ pageId: "NEW", parentId: "NEW" });
    expect(await row("NEW2a")).toMatchObject({
      pageId: "NEW2",
      parentId: "NEW2",
    });
  });

  test("a create joining ANY other partition is a 400 — and writes nothing", async () => {
    await seedPage();
    await seedBlock({
      id: "OTHER",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a1",
    });
    const message = await refusedWith(
      patch({
        creates: [
          blockOf({
            id: "c3",
            parentId: "P",
            pageId: "P",
            type: "text",
            rank: "a5",
          }),
          blockOf({
            id: "stray",
            parentId: "OTHER",
            pageId: "OTHER",
            type: "text",
            rank: "a0",
          }),
        ],
      }),
      400,
    );
    expect(message).toMatch(/created under page OTHER/);
    // The guard runs before the write, inside the same transaction: the
    // legitimate create beside the stray one did not land either.
    expect(await row("stray")).toBeUndefined();
    expect(await row("c3")).toBeUndefined();
  });

  test("ONE blocksChanged per created page, beside the patched page's own", async () => {
    await seedPage();
    await t.db.execute(sql`DELETE FROM event_emissions`);
    await patch({
      creates: [
        newPage({ id: "NEW", parentId: "P", pageId: "P", rank: "a5" }),
        newPage({ id: "NEW2", parentId: "NEW", pageId: "NEW", rank: "a0" }),
      ],
    });
    const res = await t.db.execute<{ page_id: string }>(
      sql`SELECT payload->>'pageId' AS page_id FROM event_emissions
          WHERE event_name = 'page.blocksChanged'`,
    );
    expect(res.rows.map((r) => r.page_id).sort()).toEqual(["NEW", "NEW2", "P"]);
  });
});

describe("applyPageBlockPatch — the workspace root (pageId null)", () => {
  const rootPatch = (p: Partial<Parameters<typeof applyPageBlockPatch>[1]>) =>
    applyPageBlockPatch(
      null,
      { creates: [], updates: [], deleteIds: [], ...p },
      t.db,
    );

  test("mints a root page with its body and sub-page, and reads back the root pages", async () => {
    await seedPage();
    await t.db.execute(sql`DELETE FROM event_emissions`);
    const { blocks } = await rootPatch({
      creates: [
        blockOf({
          id: "R",
          parentId: null,
          pageId: null,
          type: "page",
          rank: "a5",
        }),
        blockOf({
          id: "R1",
          parentId: "R",
          pageId: "R",
          type: "text",
          rank: "a0",
          text: "intro",
        }),
        blockOf({
          id: "RS",
          parentId: "R",
          pageId: "R",
          type: "page",
          rank: "a1",
        }),
      ],
    });
    expect(await row("R")).toMatchObject({ pageId: null, parentId: null });
    expect(await row("R1")).toMatchObject({ pageId: "R", parentId: "R" });
    expect(await row("RS")).toMatchObject({ pageId: "R", parentId: "R" });
    // The read-back is the root's own rows: every root page, the seeded one too.
    expect(blocks.map((b) => b.id)).toEqual(["P", "R"]);
    // No event for the root itself — only for the pages the patch created.
    const res = await t.db.execute<{ page_id: string }>(
      sql`SELECT payload->>'pageId' AS page_id FROM event_emissions
          WHERE event_name = 'page.blocksChanged'`,
    );
    expect(res.rows.map((r) => r.page_id).sort()).toEqual(["R", "RS"]);
  });

  test("updates and deletes a root page it reads under the root lock", async () => {
    await seedPage();
    await rootPatch({
      updates: [{ id: "P", changes: { rank: Rank.from("a9") } }],
    });
    expect(await row("P")).toMatchObject({ rank: "a9" });
    await rootPatch({ deleteIds: ["P"] });
    expect((await row("P"))?.deletedAt).not.toBeNull();
  });

  test("a root patch may not create inside an existing page", async () => {
    await seedPage();
    const message = await refusedWith(
      rootPatch({
        creates: [
          blockOf({
            id: "c3",
            parentId: "P",
            pageId: "P",
            type: "text",
            rank: "a5",
          }),
        ],
      }),
      400,
    );
    expect(message).toMatch(/created under page P/);
  });
});

describe("a data edit never changes a page's author — refused on every rewrite path", () => {
  /** P ▸ [HUMAN (a human's sub-page), AGENT (an agent-authored one)]. */
  async function seedPages(): Promise<void> {
    await seedPage();
    await seedBlock({
      id: "HUMAN",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a5",
    });
    await t.db.insert(_blocks).values({
      id: "AGENT",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a6",
      data: parseBlockData("page", agentData("Findings")),
    });
  }

  test("patch: an update marking a human's page as the agent's is a 409", async () => {
    await seedPages();
    await refusedWith(
      patch({
        updates: [
          {
            id: "HUMAN",
            changes: { data: { title: "HUMAN", icon: null, author: "agent" } },
          },
        ],
      }),
      409,
    );
    expect(await storedData("HUMAN")).toEqual({ title: "HUMAN", icon: null });
  });

  test("patch: an update DROPPING the marker is a 409 — a title edit must carry it", async () => {
    await seedPages();
    await refusedWith(
      patch({
        updates: [
          { id: "AGENT", changes: { data: { title: "Renamed", icon: null } } },
        ],
      }),
      409,
    );
    // The same rename, carrying the stored data through as every page-data
    // writer does (`{...pageData(page), title}`), is an ordinary edit.
    await patch({
      updates: [
        {
          id: "AGENT",
          changes: { data: { ...agentData("Findings"), title: "Renamed" } },
        },
      ],
    });
    expect(await storedData("AGENT")).toEqual({
      ...agentData("Findings"),
      title: "Renamed",
    });
  });

  test("patch: a full-row OVERWRITE (a create on a live row) flipping it is a 409", async () => {
    await seedPages();
    await refusedWith(
      patch({
        creates: [
          {
            ...blockOf({
              id: "AGENT",
              parentId: "P",
              pageId: "P",
              type: "page",
              rank: "a6",
            }),
            data: { title: "Findings", icon: null },
          },
        ],
      }),
      409,
    );
  });

  test("op: the reducer's persist is judged the same way", async () => {
    await seedPages();
    await refusedWith(
      withPageForest(
        "P",
        async (ctx) => {
          const before = (await ctx.forest()).map(rowToNode);
          const after = before.map((n) =>
            n.id === "HUMAN"
              ? { ...n, data: { title: "HUMAN", icon: null, author: "agent" } }
              : n,
          );
          return writeForestTarget(ctx, before, after);
        },
        t.db,
      ),
      409,
    );
    expect(await storedData("HUMAN")).toEqual({ title: "HUMAN", icon: null });
  });
});

describe("applyPageBlockPatch — a move that names only `parentId`", () => {
  test("keeps its rank under the new parent instead of landing at its park key", async () => {
    // P ▸ [A ▸ [x a0, y a1], B, q]. `x` and `y` move under B keeping their rank
    // strings, so their updates name `parentId` alone; `q` moves in after them.
    // Parking bumps x and y to a2 / a3 under A — a phase 2 that wrote only the
    // named fields left them there, putting x on q's a2 (the unique index fired).
    await seedBlock({
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "x",
      parentId: "A",
      pageId: "P",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "y",
      parentId: "A",
      pageId: "P",
      type: "text",
      rank: "a1",
    });
    await seedBlock({
      id: "B",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a1",
    });
    await seedBlock({
      id: "q",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a2",
    });

    await patch({
      updates: [
        { id: "x", changes: { parentId: "B" } },
        { id: "y", changes: { parentId: "B" } },
        { id: "q", changes: { parentId: "B", rank: Rank.from("a2") } },
      ],
    });

    expect(await liveChildren("B")).toEqual(["x", "y", "q"]);
    expect((await row("x"))?.rank).toBe("a0");
    expect((await row("y"))?.rank).toBe("a1");
    expect(await liveChildren("A")).toEqual([]);
  });
});
