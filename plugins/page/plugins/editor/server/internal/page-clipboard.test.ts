/**
 * Real-DB suite for pasting a sub-page — `applyPageBlockOp` driven headlessly
 * against a throwaway Postgres (db-test-fixture) with the REAL migration chain.
 *
 * A copied page node carries no content, only its `pageSource`. What it pins:
 *  - the first paste of a CUT page (the node keeps the page's own id) MOVES the
 *    page: same id, its whole content (nested sub-pages included) back out of
 *    the trash, the cut's entry consumed — and only the page's own rows when
 *    the cut held more;
 *  - a claim of a page that is live elsewhere moves it too;
 *  - a COPY (fresh id) clones the whole content, nested sub-pages included,
 *    runs the `OnCopy` hooks over every pair, and leaves the source untouched;
 *  - a duplicate of a sub-page is a copy;
 *  - pasting a copy of a page into that page terminates;
 *  - moving a page into its own content is refused.
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
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import {
  defineBlock,
  textBlockSchema,
  type BlockOp,
  type IdentifiedBlock,
} from "../../core";
import { pageBlockHandle } from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle, type CopiedBlock } from "./document-hooks";
import { deleteBlocksSubtree } from "./trash-blocks";
import { applyPageBlockOp } from "./handle-apply-block-op";

const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

let t: TestDb;
const copyCalls: CopiedBlock[][] = [];

beforeAll(async () => {
  t = await createTestDb({ prefix: "page_clipboard_test" });
  await runMigrations(t.db);
  collectContributions([
    {
      id: "page-clipboard-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        BlockLifecycle.OnCopy({
          onCopy: (blocks) => {
            copyCalls.push([...blocks]);
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
  copyCalls.length = 0;
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function seed(
  id: string,
  parentId: string | null,
  pageId: string | null,
  type: "page" | "text",
  rank: string,
): Promise<void> {
  await t.db.insert(_blocks).values({
    id,
    parentId,
    pageId,
    type,
    rank,
    data: parseBlockData(
      type,
      type === "page" ? { title: id, icon: null } : { text: id },
    ),
  });
}

/**
 * Two root pages A and B. A holds sub-page S; S holds `s1` (with child
 * `s1a`) and a nested sub-page S2, which holds `s2x`.
 */
async function seedTree(): Promise<void> {
  await seed("A", null, null, "page", "a0");
  await seed("B", null, null, "page", "a1");
  await seed("a-para", "A", "A", "text", "a0");
  await seed("S", "A", "A", "page", "a1");
  await seed("s1", "S", "S", "text", "a0");
  await seed("s1a", "s1", "S", "text", "a0");
  await seed("S2", "S", "S", "page", "a1");
  await seed("s2x", "S2", "S2", "text", "a0");
}

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  return r;
}

async function liveRowsOf(pageId: string) {
  const rows = await t.db
    .select()
    .from(_blocks)
    .where(eq(_blocks.pageId, pageId));
  return rows.filter((r) => r.deletedAt === null);
}

function pageNode(id: string, sourcePageId: string): IdentifiedBlock {
  return {
    id,
    type: "page",
    data: { title: sourcePageId, icon: null },
    expanded: true,
    children: [],
    pageSource: { pageId: sourcePageId },
  };
}

function pasteInto(pageId: string, forest: IdentifiedBlock[]): BlockOp {
  return { kind: "paste", forest, afterId: null, parentId: pageId };
}

async function entryCount(): Promise<number> {
  return (await t.db.select().from(_trashEntries)).length;
}

// ── Move (the first paste of a cut) ─────────────────────────────────────────

describe("a claimed page moves", () => {
  test("a cut page comes back out of the trash under the destination, whole", async () => {
    await seedTree();
    await deleteBlocksSubtree(["S"], t.db);
    expect((await row("s2x"))!.deletedAt).not.toBeNull();

    await applyPageBlockOp("B", pasteInto("B", [pageNode("S", "S")]), t.db);

    const s = (await row("S"))!;
    expect(s.deletedAt).toBeNull();
    expect(s.parentId).toBe("B");
    expect(s.pageId).toBe("B");
    for (const id of ["s1", "s1a", "S2", "s2x"]) {
      expect((await row(id))!.deletedAt).toBeNull();
    }
    expect((await liveRowsOf("A")).map((r) => r.id)).toEqual(["a-para"]);
    expect(await entryCount()).toBe(0);
    // Nothing was copied: the page is the same page.
    expect(copyCalls).toEqual([]);
    expect((await t.db.select().from(_blocks)).length).toBe(8);
  });

  test("a cut that also held a paragraph takes back only the page's rows", async () => {
    await seedTree();
    await deleteBlocksSubtree(["a-para", "S"], t.db);
    const entryOfPara = (await row("a-para"))!.trashEntryId;
    expect(entryOfPara).toBe((await row("S"))!.trashEntryId);

    // The clipboard's paragraph is a fresh copy; the page is claimed.
    const para: IdentifiedBlock = {
      id: "para-copy",
      type: "text",
      data: { text: [{ text: "a-para" }] },
      expanded: true,
      children: [],
    };
    await applyPageBlockOp(
      "B",
      pasteInto("B", [para, pageNode("S", "S")]),
      t.db,
    );

    expect((await row("S"))!.deletedAt).toBeNull();
    expect((await row("s2x"))!.deletedAt).toBeNull();
    const original = (await row("a-para"))!;
    expect(original.trashEntryId).toBe(entryOfPara);
    expect(await entryCount()).toBe(1);
  });

  test("a claim of a page live elsewhere moves it", async () => {
    await seedTree();
    await applyPageBlockOp("B", pasteInto("B", [pageNode("S", "S")]), t.db);
    const s = (await row("S"))!;
    expect([s.parentId, s.pageId, s.deletedAt]).toEqual(["B", "B", null]);
    expect((await liveRowsOf("S")).map((r) => r.id).sort()).toEqual([
      "S2",
      "s1",
      "s1a",
    ]);
  });

  test("moving a page into its own content is refused", async () => {
    await seedTree();
    await deleteBlocksSubtree(["S"], t.db);
    const err = await applyPageBlockOp(
      "S2",
      pasteInto("S2", [pageNode("S", "S")]),
      t.db,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((await row("S"))!.deletedAt).not.toBeNull();
  });
});

// ── Copy ────────────────────────────────────────────────────────────────────

describe("a page node with a fresh id is a deep copy", () => {
  test("clones the content, nested sub-pages included, and leaves the source alone", async () => {
    await seedTree();
    await applyPageBlockOp("B", pasteInto("B", [pageNode("N", "S")]), t.db);

    const top = await liveRowsOf("N");
    expect(top.map((r) => r.type).sort()).toEqual(["page", "text", "text"]);
    const s1Copy = top.find((r) => r.parentId === "N" && r.type === "text")!;
    const s1aCopy = top.find((r) => r.parentId === s1Copy.id)!;
    expect(s1aCopy.data).toEqual((await row("s1a"))!.data);
    const s2Copy = top.find((r) => r.type === "page")!;
    expect(s2Copy.id).not.toBe("S2");
    const nested = await liveRowsOf(s2Copy.id);
    expect(nested).toHaveLength(1);
    expect(nested[0]!.parentId).toBe(s2Copy.id);
    expect(nested[0]!.data).toEqual((await row("s2x"))!.data);

    // Source untouched.
    expect((await liveRowsOf("S")).map((r) => r.id).sort()).toEqual([
      "S2",
      "s1",
      "s1a",
    ]);
    // One hook call covering every pair, the page rows included.
    expect(copyCalls).toHaveLength(1);
    const pairs = copyCalls[0]!.map((c) => [c.sourceId, c.copyId]);
    expect(pairs).toContainEqual(["S", "N"]);
    expect(pairs).toContainEqual(["S2", s2Copy.id]);
    expect(pairs).toHaveLength(5);
  });

  test("a copy of a since-deleted page clones what it held", async () => {
    await seedTree();
    await deleteBlocksSubtree(["S"], t.db);
    await applyPageBlockOp("B", pasteInto("B", [pageNode("N", "S")]), t.db);
    expect(await liveRowsOf("N")).toHaveLength(3);
    expect((await row("S"))!.deletedAt).not.toBeNull();
  });

  test("pasting a copy of a page into that page terminates", async () => {
    await seedTree();
    await applyPageBlockOp("S", pasteInto("S", [pageNode("N", "S")]), t.db);
    // N holds S's content as it was: s1, s1a, S2 — not a copy of itself.
    expect((await liveRowsOf("N")).map((r) => r.type).sort()).toEqual([
      "page",
      "text",
      "text",
    ]);
  });

  test("a duplicate of a sub-page is a deep copy", async () => {
    await seedTree();
    await applyPageBlockOp(
      "A",
      {
        kind: "duplicate",
        placements: [{ afterId: "S", forest: [pageNode("D", "S")] }],
      },
      t.db,
    );
    expect((await row("D"))!.pageId).toBe("A");
    expect(await liveRowsOf("D")).toHaveLength(3);
  });
});
