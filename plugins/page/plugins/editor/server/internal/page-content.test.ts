/**
 * Real-DB suite for history restore — `restorePageContent` driven against a
 * throwaway Postgres (db-test-fixture) with the REAL migration chain, so the
 * self-FK, the partial unique indexes and the trash-flags CHECK are exactly
 * what production applies.
 *
 * Restore changes a page by block IDENTITY
 * (research/2026-09-11-page-history-restore-preserves-block-identity.md §5):
 * a block in both the page and the version keeps its id and its content doc, a
 * block deleted since comes back as itself, a block created since is trashed.
 * The text phase is a recording stub here — the real writer
 * (`page/block-text-write`) imports this plugin, so it cannot be imported back —
 * which is also what lets every test prove that phase 2 never touches a doc or
 * a row's text.
 *
 * Every test ends with the ledger invariant asserted: an entry exists ⇔ at
 * least one row carries its id.
 *
 * Run: `./equin test plugins/page/plugins/editor`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { trashEntryIdKind } from "@plugins/infra/plugins/trash/core";
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
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
import { defineBlock, textBlockSchema, type RichText } from "../../core";
import {
  pageBlockHandle,
  pageData,
  PAGES_TRASH_SOURCE,
  PAGE_BLOCKS_TRASH_SOURCE,
} from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle } from "./document-hooks";
import { applyPageBlockPatch } from "./handle-patch-blocks";
import { deleteBlocksSubtree, purgeTrashedBlocks } from "./trash-blocks";
import {
  restorePageContent,
  serializePageContent,
  type PageContentSnapshot,
} from "./page-content";
import { setPageKindOf } from "./handle-set-page-kind";

// Stand-ins for `page/text` and `page/divider` (the concrete block plugins
// import this one, so importing them back would be a cycle). One text-bearing,
// one void, so the restore's text rule can be pinned in both directions.
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});
const dividerStub = defineBlock({
  type: "divider",
  schema: z.object({}),
  empty: () => ({}),
});

let t: TestDb;

const trashCalls: string[][] = [];
const restoreCalls: string[][] = [];
/** Every call the restore made to its text writer, in order. */
const textCalls: {
  pageId: string;
  edits: { blockId: string; runs: RichText }[];
}[] = [];

beforeAll(async () => {
  t = await createTestDb({ prefix: "page_content_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  // Re-installed per test: the registry is process-global, and another suite
  // in the same run installs its own.
  collectContributions([
    {
      id: "page-content-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        Editor.BlockData(dividerStub),
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
      ],
    },
  ]);
  trashCalls.length = 0;
  restoreCalls.length = 0;
  textCalls.length = 0;
  await t.db.execute(sql`DELETE FROM page_blocks`);
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
  type?: string;
  rank: string;
  text?: string;
  title?: string;
}): Promise<void> {
  const type = args.type ?? "text";
  await t.db.insert(_blocks).values({
    id: args.id,
    parentId: args.parentId,
    pageId: args.pageId,
    type,
    rank: args.rank,
    data: parseBlockData(
      type,
      type === "page"
        ? { title: args.title ?? args.id, icon: null }
        : type === "divider"
          ? {}
          : { text: args.text ?? "" },
    ),
  });
}

/** A root page `id` at the workspace root. */
async function seedPage(id: string, rank = "a0"): Promise<void> {
  await seedBlock({
    id,
    parentId: null,
    pageId: null,
    type: "page",
    rank,
    title: id,
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

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

async function maybeRow(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  return r;
}

/** Move/retype/rewrite a row the way a past edit would have left it. */
async function setRow(
  id: string,
  changes: Partial<typeof _blocks.$inferInsert>,
): Promise<void> {
  await t.db.update(_blocks).set(changes).where(eq(_blocks.id, id));
}

const textOfRow = (r: { data: unknown }): string =>
  ((r.data as { text?: { text: string }[] }).text ?? [])
    .map((run) => run.text)
    .join("");

/** Live rows of page `pageId` (sub-page shells included), by id. */
async function liveRowsOf(pageId: string) {
  const rows = await t.db.execute<{
    id: string;
    parent_id: string | null;
    type: string;
    rank: string;
  }>(
    sql`SELECT id, parent_id, type, rank FROM page_blocks
        WHERE page_id = ${pageId} AND deleted_at IS NULL ORDER BY id`,
  );
  return rows.rows;
}

async function entries() {
  return (await t.db.select().from(_trashEntries)).map((e) =>
    TrashEntrySchema.parse(e),
  );
}

async function onlyEntry() {
  const all = await entries();
  expect(all).toHaveLength(1);
  return all[0]!;
}

/** A user's delete: the patch handler's inline trash, one `page-blocks` entry. */
async function userDelete(pageId: string, ids: string[]): Promise<string> {
  const before = new Set((await entries()).map((e) => e.id));
  await applyPageBlockPatch(
    pageId,
    { creates: [], updates: [], deleteIds: ids },
    t.db,
  );
  const minted = (await entries()).filter((e) => !before.has(e.id));
  expect(minted).toHaveLength(1);
  return minted[0]!.id;
}

async function snapshot(pageId: string): Promise<PageContentSnapshot> {
  // `serializePageContent` reads through a transaction handle here: its
  // executor is the global handle's type, which a fixture DB is not.
  const snap = await t.db.transaction((tx) => serializePageContent(pageId, tx));
  if (!snap) throw new Error(`no snapshot for ${pageId}`);
  return snap;
}

function restore(pageId: string, snap: PageContentSnapshot): Promise<void> {
  return restorePageContent(
    pageId,
    snap,
    {
      writeTexts: (p, edits) => {
        textCalls.push({ pageId: p, edits: [...edits] });
        return Promise.resolve();
      },
    },
    t.db,
  );
}

/** The runs the stub was asked to write for `blockId`, or undefined. */
function textEditFor(blockId: string): RichText | undefined {
  return textCalls.flatMap((c) => c.edits).find((e) => e.blockId === blockId)
    ?.runs;
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

// ── Survivors ──────────────────────────────────────────────────────────────

describe("survivors keep their identity", () => {
  test("a survivor keeps its id, created_at and doc, moves to its version (parent, rank), and gets its text only through the writer", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "B",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "bravo",
    });
    await seedBlock({
      id: "C",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "charlie",
    });
    await seedDoc("A", "0a0a0a");
    await seedDoc("B", "0b0b0b");
    const v1 = await snapshot("P");
    const createdA = (await row("A")).createdAt;

    // Since the version: A's text changed and it moved under C; B moved last.
    await setRow("A", {
      parentId: "C",
      rank: "a0",
      data: parseBlockData("text", { text: "alpha EDITED" }),
    });
    await setRow("B", { rank: "a3" });

    await restore("P", v1);

    const a = await row("A");
    expect(a.parentId).toBe("P");
    expect(a.rank).toBe("a0");
    expect(a.deletedAt).toBeNull();
    expect(a.createdAt).toEqual(createdA);
    // Phase 2 leaves the projection alone: the doc owns the text, and the
    // text phase edits it.
    expect(textOfRow(a)).toBe("alpha EDITED");
    expect(await docHex("A")).toBe("0a0a0a");
    expect(await docHex("B")).toBe("0b0b0b");
    expect((await row("B")).rank).toBe("a1");

    // Every text-bearing survivor gets an edit to the version's runs — in ONE
    // call, after the structure.
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0]!.pageId).toBe("P");
    expect(textEditFor("A")).toEqual([{ text: "alpha" }]);
    expect(textEditFor("B")).toEqual([{ text: "bravo" }]);
    expect(textEditFor("C")).toEqual([{ text: "charlie" }]);

    // Nothing was removed, so nothing was trashed.
    expect(await entries()).toHaveLength(0);
  });

  test("text follows the type: void → text writes the version's text, text → void carries none", async () => {
    await seedPage("P");
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "hello",
    });
    await seedBlock({
      id: "Y",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      type: "divider",
    });
    await seedDoc("X", "0c0c0c");
    const v1 = await snapshot("P");

    await setRow("X", { type: "divider", data: parseBlockData("divider", {}) });
    await setRow("Y", {
      type: "text",
      data: parseBlockData("text", { text: "was a divider" }),
    });

    await restore("P", v1);

    const x = await row("X");
    expect(x.type).toBe("text");
    // A text-bearing row needs a text; the doc from X's earlier text life is
    // untouched here and edited by the text phase.
    expect(textOfRow(x)).toBe("hello");
    expect(await docHex("X")).toBe("0c0c0c");
    expect(textEditFor("X")).toEqual([{ text: "hello" }]);

    const y = await row("Y");
    expect(y.type).toBe("divider");
    expect(Object.keys(y.data)).toEqual([]);
    expect(textEditFor("Y")).toBeUndefined();
  });

  test("a survivor reparented out of a block the restore trashes stays live", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "C",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "charlie",
    });
    const v1 = await snapshot("P");

    // Since the version: a new block N, with C moved under it.
    await seedBlock({
      id: "N",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "new",
    });
    await setRow("C", { parentId: "N", rank: "a0" });

    await restore("P", v1);

    const c = await row("C");
    expect(c.deletedAt).toBeNull();
    expect(c.parentId).toBe("P");
    expect(c.rank).toBe("a1");
    const entry = await onlyEntry();
    expect((await row("N")).trashEntryId).toBe(entry.id);
    expect(trashCalls).toEqual([["N"]]);
  });
});

// ── Trashed and revived ────────────────────────────────────────────────────

describe("blocks created and deleted since the version", () => {
  test("a block created after the version is trashed under exactly one page-blocks entry, its doc intact", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    const v1 = await snapshot("P");

    await seedBlock({
      id: "N1",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "new one",
    });
    await seedBlock({
      id: "N2",
      parentId: "N1",
      pageId: "P",
      rank: "a0",
      text: "its child",
    });
    await seedDoc("N1", "0d0d0d");
    await seedDoc("N2", "0e0e0e");

    await restore("P", v1);

    const entry = await onlyEntry();
    expect(entry.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    expect(entry.rootEntityId).toBe("N1");
    for (const id of ["N1", "N2"]) {
      const r = await row(id);
      expect(r.deletedAt).toBeInstanceOf(Date);
      expect(r.trashEntryId).toBe(entry.id);
    }
    // Trash never touches a doc: undoing the restore brings them back exact.
    expect(await docHex("N1")).toBe("0d0d0d");
    expect(await docHex("N2")).toBe("0e0e0e");
    expect((await row("A")).deletedAt).toBeNull();
    expect(trashCalls).toEqual([["N1", "N2"]]);
  });

  test("a block deleted after the version comes back as itself, at its version rank, even though a later insert took that exact rank", async () => {
    await seedPage("P");
    // Two inserts between the same neighbours mint the same key: nBetween is
    // deterministic. So a block inserted where a since-deleted one sat takes
    // its rank exactly.
    const mid = Rank.between(Rank.from("a0"), Rank.from("a2")).toJSON();
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: mid,
      text: "xray",
    });
    await seedBlock({
      id: "C",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "charlie",
    });
    await seedDoc("X", "0f0f0f");
    const v1 = await snapshot("P");
    const createdX = (await row("X")).createdAt;

    const deletedEntry = await userDelete("P", ["X"]);
    await seedBlock({
      id: "N",
      parentId: "P",
      pageId: "P",
      rank: mid,
      text: "took its slot",
    });

    await restore("P", v1);

    const x = await row("X");
    expect(x.deletedAt).toBeNull();
    expect(x.trashEntryId).toBeNull();
    expect(x.parentId).toBe("P");
    expect(x.rank).toBe(mid);
    expect(x.createdAt).toEqual(createdX);
    expect(await docHex("X")).toBe("0f0f0f");
    expect(restoreCalls).toEqual([["X"]]);

    // Its entry is consumed; the one entry left is the restore's own, for N.
    const entry = await onlyEntry();
    expect(entry.id).not.toBe(deletedEntry);
    expect((await row("N")).trashEntryId).toBe(entry.id);
    expect(textEditFor("X")).toEqual([{ text: "xray" }]);
  });

  test("a revived entry holding a row the version lacks leaves that row trashed, under the restore's entry", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "xray",
    });
    const v1 = await snapshot("P");

    await seedBlock({
      id: "Y",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "yankee",
    });
    const deletedEntry = await userDelete("P", ["X", "Y"]);

    await restore("P", v1);

    expect((await row("X")).deletedAt).toBeNull();
    const entry = await onlyEntry();
    expect(entry.id).not.toBe(deletedEntry);
    const y = await row("Y");
    expect(y.deletedAt).toBeInstanceOf(Date);
    expect(y.trashEntryId).toBe(entry.id);
  });

  test("a purged block is re-inserted under its ORIGINAL id, its version text the seed (no text edit)", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "xray",
    });
    await seedDoc("X", "1a1a1a");
    const v1 = await snapshot("P");

    const entryId = await userDelete("P", ["X"]);
    const [entry] = (await entries()).filter((e) => e.id === entryId);
    await purgeTrashedBlocks([entry!], t.db);
    // The trash primitive deletes the ledger row after a purge; mirror it.
    await t.db
      .delete(_trashEntries)
      .where(eq(_trashEntries.id, trashEntryIdKind.key(entryId)));
    expect(await maybeRow("X")).toBeUndefined();

    await restore("P", v1);

    const x = await row("X");
    expect(x.deletedAt).toBeNull();
    expect(x.parentId).toBe("P");
    expect(x.rank).toBe("a1");
    expect(textOfRow(x)).toBe("xray");
    // The purge took its doc; the row is the seed of the next one.
    expect(await docHex("X")).toBeUndefined();
    expect(textEditFor("X")).toBeUndefined();
    expect(textEditFor("A")).toEqual([{ text: "alpha" }]);
    expect(await entries()).toHaveLength(0);
  });
});

// ── Copies ─────────────────────────────────────────────────────────────────

describe("a version block whose id is taken comes back as a fresh-id copy", () => {
  test("a block now live on another page: a copy, its children remapped, the other page untouched", async () => {
    await seedPage("P", "a0");
    await seedPage("Q", "a1");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "M",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "mover",
    });
    await seedBlock({
      id: "K",
      parentId: "M",
      pageId: "P",
      rank: "a0",
      text: "kid",
    });
    const v1 = await snapshot("P");

    // Since the version: M (with K) was dragged to page Q.
    await setRow("M", { parentId: "Q", pageId: "Q", rank: "a0" });
    await setRow("K", { pageId: "Q" });
    const qBefore = await liveRowsOf("Q");

    await restore("P", v1);

    const live = await liveRowsOf("P");
    const copyM = live.find((r) => r.parent_id === "P" && r.rank === "a1");
    expect(copyM).toBeDefined();
    expect(copyM!.id).not.toBe("M");
    expect(textOfRow(await row(copyM!.id))).toBe("mover");
    const copyK = live.find((r) => r.parent_id === copyM!.id);
    expect(copyK).toBeDefined();
    expect(copyK!.id).not.toBe("K");
    expect(textOfRow(await row(copyK!.id))).toBe("kid");
    expect(live.map((r) => r.id).sort()).toEqual(
      ["A", copyM!.id, copyK!.id].sort(),
    );

    // Q is exactly as it was, and the copies carry their text as a seed.
    expect(await liveRowsOf("Q")).toEqual(qBefore);
    expect(textEditFor(copyM!.id)).toBeUndefined();
    expect(textEditFor(copyK!.id)).toBeUndefined();
    expect(await entries()).toHaveLength(0);
  });

  test("a block in a trash entry that also holds another page's row: a copy, and the other page's row stays trashed", async () => {
    await seedPage("P", "a0");
    await seedPage("Q", "a1");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "xray",
    });
    await seedBlock({
      id: "Y",
      parentId: "Q",
      pageId: "Q",
      rank: "a0",
      text: "on Q",
    });
    const v1 = await snapshot("P");

    // One page-free delete over two pages mints ONE `page-blocks` entry.
    await deleteBlocksSubtree(["X", "Y"], t.db);
    const shared = await onlyEntry();
    expect(shared.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);

    await restore("P", v1);

    // Reviving the entry would bring Y back on Q, a page this restore does
    // not write — so it is left alone, and X comes back as a copy.
    expect(await onlyEntry()).toEqual(shared);
    expect((await row("X")).trashEntryId).toBe(shared.id);
    expect((await row("Y")).trashEntryId).toBe(shared.id);
    const copy = (await liveRowsOf("P")).find((r) => r.rank === "a1");
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe("X");
    expect(textOfRow(await row(copy!.id))).toBe("xray");
    expect(restoreCalls).toEqual([]);
  });

  test("a content row trashed together with a sub-page (a `pages` entry): a copy, and the sub-page stays trashed", async () => {
    await seedPage("P");
    await seedBlock({
      id: "T",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "holder",
    });
    await seedBlock({
      id: "S",
      parentId: "T",
      pageId: "P",
      type: "page",
      rank: "a0",
      title: "Sub",
    });
    await seedBlock({
      id: "S1",
      parentId: "S",
      pageId: "S",
      rank: "a0",
      text: "sub content",
    });
    const v1 = await snapshot("P");

    await deleteBlocksSubtree(["T"], t.db);
    const pagesEntry = await onlyEntry();
    expect(pagesEntry.sourceId).toBe(PAGES_TRASH_SOURCE);

    await restore("P", v1);

    // No revival: the pages entry is intact and still holds all three rows.
    expect(await onlyEntry()).toEqual(pagesEntry);
    for (const id of ["T", "S", "S1"]) {
      expect((await row(id)).trashEntryId).toBe(pagesEntry.id);
    }
    // T's text comes back as a copy; the sub-page does not (a restore never
    // mints a sub-page).
    const live = await liveRowsOf("P");
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe("T");
    expect(live[0]!.rank).toBe("a0");
    expect(textOfRow(await row(live[0]!.id))).toBe("holder");
    expect(restoreCalls).toEqual([]);
  });
});

// ── Sub-page shells ────────────────────────────────────────────────────────

describe("sub-page shells are never created, revived, removed or renamed", () => {
  test("a shell in the version returns to its version position and keeps its CURRENT title; the page row takes the version's", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "S",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a1",
      title: "Old title",
    });
    await seedBlock({
      id: "S1",
      parentId: "S",
      pageId: "S",
      rank: "a0",
      text: "sub content",
    });
    await seedBlock({
      id: "B",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "bravo",
    });
    const v1 = await snapshot("P");

    // Since the version: the sub-page was renamed and moved under A, and the
    // page itself was renamed.
    await setRow("S", {
      parentId: "A",
      rank: "a0",
      data: parseBlockData("page", { title: "New title", icon: null }),
    });
    await setRow("P", {
      data: parseBlockData("page", { title: "Renamed page", icon: null }),
    });

    await restore("P", v1);

    const s = await row("S");
    expect(s.deletedAt).toBeNull();
    expect(s.parentId).toBe("P");
    expect(s.rank).toBe("a1");
    expect(pageData(s).title).toBe("New title");
    // Its own content is another page's, untouched.
    const s1 = await row("S1");
    expect(s1.deletedAt).toBeNull();
    expect(s1.parentId).toBe("S");
    // The restored page's own title is the version's.
    expect(pageData(await row("P")).title).toBe("P");
    expect(await entries()).toHaveLength(0);
  });

  test("a shell not in the version keeps its place, or is re-homed above the target when its slot is claimed or its parent is trashed", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "B",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "bravo",
    });
    const v1 = await snapshot("P");

    // Since the version:
    //  - S1, a new sub-page on a free slot — it keeps its place;
    //  - B deleted, and S2 made on B's old slot — B claims it back;
    //  - N, a new block holding a sub-page S3 — N is trashed, S3 is not.
    await seedBlock({
      id: "S1",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a5",
      title: "Keeper",
    });
    const deletedB = await userDelete("P", ["B"]);
    await seedBlock({
      id: "S2",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a1",
      title: "Squatter",
    });
    await seedBlock({
      id: "N",
      parentId: "P",
      pageId: "P",
      rank: "a6",
      text: "new",
    });
    await seedBlock({
      id: "S3",
      parentId: "N",
      pageId: "P",
      type: "page",
      rank: "a0",
      title: "Nested",
    });
    trashCalls.length = 0;

    await restore("P", v1);

    const s1 = await row("S1");
    expect([s1.parentId, s1.rank]).toEqual(["P", "a5"]);
    const b = await row("B");
    expect(b.deletedAt).toBeNull();
    expect([b.parentId, b.rank]).toEqual(["P", "a1"]);

    // Both re-homed shells land at the top level, above every target rank
    // there (a5), live, titles untouched.
    for (const [id, title] of [
      ["S2", "Squatter"],
      ["S3", "Nested"],
    ] as const) {
      const s = await row(id);
      expect(s.deletedAt).toBeNull();
      expect(s.parentId).toBe("P");
      expect(s.rank > "a5").toBe(true);
      expect(pageData(s).title).toBe(title);
    }
    expect((await row("S2")).rank).not.toBe((await row("S3")).rank);

    // Only N was trashed — B's entry was consumed by the revival.
    const entry = await onlyEntry();
    expect(entry.id).not.toBe(deletedB);
    expect(entry.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    expect((await row("N")).trashEntryId).toBe(entry.id);
    expect(trashCalls).toEqual([["N"]]);
  });

  test("a trashed sub-page is not revived", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "S",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a1",
      title: "Sub",
    });
    await seedBlock({
      id: "S1",
      parentId: "S",
      pageId: "S",
      rank: "a0",
      text: "sub content",
    });
    const v1 = await snapshot("P");

    await deleteBlocksSubtree(["S"], t.db);
    const pagesEntry = await onlyEntry();

    await restore("P", v1);

    expect((await row("S")).trashEntryId).toBe(pagesEntry.id);
    expect((await row("S1")).trashEntryId).toBe(pagesEntry.id);
    expect(await onlyEntry()).toEqual(pagesEntry);
    expect((await liveRowsOf("P")).map((r) => r.id)).toEqual(["A"]);
  });

  test("a version block turned into a sub-page since: the sub-page keeps its content, and the version block comes back as a copy", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "X",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "xray",
    });
    const v1 = await snapshot("P");

    // Turn into page: same id, same slot, now a page row with its own content.
    await setRow("X", {
      type: "page",
      data: parseBlockData("page", { title: "X page", icon: null }),
    });
    await seedBlock({
      id: "X1",
      parentId: "X",
      pageId: "X",
      rank: "a0",
      text: "x content",
    });

    await restore("P", v1);

    const x = await row("X");
    expect(x.type).toBe("page");
    expect(x.deletedAt).toBeNull();
    expect(pageData(x).title).toBe("X page");
    // Its slot (a1) is the version's copy's now, so it moved above the target.
    expect(x.parentId).toBe("P");
    expect(x.rank > "a1").toBe(true);
    const x1 = await row("X1");
    expect(x1.deletedAt).toBeNull();
    expect(x1.parentId).toBe("X");

    const copy = (await liveRowsOf("P")).find(
      (r) => r.parent_id === "P" && r.rank === "a1",
    );
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe("X");
    expect(copy!.type).toBe("text");
    expect(textOfRow(await row(copy!.id))).toBe("xray");
    expect(await entries()).toHaveLength(0);
  });
});

// ── Refusals, failure, convergence ─────────────────────────────────────────

describe("the restore as a whole", () => {
  test("a trashed or missing page is a 404, and nothing is written", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    const v1 = await snapshot("P");
    await deleteBlocksSubtree(["P"], t.db);
    const pagesEntry = await onlyEntry();

    for (const pageId of ["P", "never-existed"]) {
      let caught: unknown;
      try {
        await restore(pageId, v1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(404);
    }
    expect(await onlyEntry()).toEqual(pagesEntry);
    expect(textCalls).toEqual([]);
  });

  test("a text-phase failure is loud, leaves the structure committed, and a re-run finishes the job", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    const v1 = await snapshot("P");
    await seedBlock({
      id: "N",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "new",
    });

    let caught: unknown;
    try {
      await restorePageContent(
        "P",
        v1,
        { writeTexts: () => Promise.reject(new Error("doc write failed")) },
        t.db,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /Re-running the restore converges/,
    );
    expect(((caught as Error).cause as Error).message).toBe("doc write failed");
    const entry = await onlyEntry();
    expect((await row("N")).trashEntryId).toBe(entry.id);

    await restore("P", v1);
    expect(await onlyEntry()).toEqual(entry);
    expect(textEditFor("A")).toEqual([{ text: "alpha" }]);
  });

  test("restoring twice converges: the second run writes nothing and mints no entry", async () => {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    await seedBlock({
      id: "B",
      parentId: "P",
      pageId: "P",
      rank: "a1",
      text: "bravo",
    });
    await seedBlock({
      id: "C",
      parentId: "P",
      pageId: "P",
      rank: "a2",
      text: "charlie",
    });
    await seedBlock({
      id: "S",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a3",
      title: "Sub",
    });
    const v1 = await snapshot("P");

    // A mix of everything since the version.
    await setRow("A", {
      data: parseBlockData("text", { text: "alpha EDITED" }),
    });
    await setRow("C", { parentId: "B", rank: "a0" });
    await userDelete("P", ["B"]); // C goes with it
    await seedBlock({
      id: "N",
      parentId: "P",
      pageId: "P",
      rank: "a4",
      text: "new",
    });
    await setRow("P", {
      data: parseBlockData("page", { title: "Renamed page", icon: null }),
    });

    await restore("P", v1);
    const rowsAfterFirst = await t.db.execute(
      sql`SELECT * FROM page_blocks ORDER BY id`,
    );
    const entriesAfterFirst = await entries();
    expect(entriesAfterFirst).toHaveLength(1);
    trashCalls.length = 0;
    restoreCalls.length = 0;

    await restore("P", v1);

    const rowsAfterSecond = await t.db.execute(
      sql`SELECT * FROM page_blocks ORDER BY id`,
    );
    // Byte-for-byte the same rows, `updated_at` included: nothing was written.
    expect(rowsAfterSecond.rows).toEqual(rowsAfterFirst.rows);
    expect(await entries()).toEqual(entriesAfterFirst);
    expect(trashCalls).toEqual([]);
    expect(restoreCalls).toEqual([]);
  });
});

// ── The page's kind ────────────────────────────────────────────────────────

describe("a version never changes whose page it is", () => {
  /** P ▸ [A "alpha"], and its version as it stands now. */
  async function seedAndSnapshot(): Promise<PageContentSnapshot> {
    await seedPage("P");
    await seedBlock({
      id: "A",
      parentId: "P",
      pageId: "P",
      rank: "a0",
      text: "alpha",
    });
    return snapshot("P");
  }

  test("a version taken before a flip to agent restores the content and title, and the page stays the agent's", async () => {
    const v1 = await seedAndSnapshot();
    expect(v1.page.author).toBeUndefined();

    await setPageKindOf("P", { kind: "agent-page" }, t.db);
    await setRow("P", {
      data: parseBlockData("page", {
        title: "Renamed",
        icon: "🚀",
        author: "agent",
      }),
    });

    // Before the carry this was a 409: the version's data holds no marker, so
    // restoring it verbatim would have flipped the page back.
    await restore("P", v1);

    expect(pageData(await row("P"))).toEqual({
      title: "P",
      icon: null,
      author: "agent",
    });
    expect(textEditFor("A")).toEqual([{ text: "alpha" }]);
  });

  test("a version taken while the page was the agent's restores onto a human's page without re-marking it", async () => {
    await seedPage("P");
    await setPageKindOf("P", { kind: "agent-page" }, t.db);
    const v1 = await snapshot("P");
    expect(v1.page.author).toBe("agent");

    await setPageKindOf("P", { kind: "page" }, t.db);
    await restore("P", v1);

    const data = pageData(await row("P"));
    expect(data).toEqual({ title: "P", icon: null });
    expect("author" in data).toBe(false);
  });

  test("a restore keeps the page's CURRENT instructions kind, global included", async () => {
    await seedPage("P");
    const v1 = await snapshot("P");

    await setPageKindOf("P", { kind: "instructions", global: true }, t.db);
    await restore("P", v1);

    expect(pageData(await row("P"))).toEqual({
      title: "P",
      icon: null,
      instructions: true,
      global: true,
    });
  });
});
