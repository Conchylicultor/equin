/**
 * Real-DB suite for turn-into-page — `turnBlockIntoPage` driven against a
 * throwaway Postgres (db-test-fixture) with the REAL migration chain, so the
 * self-FK, the partial unique indexes and the trash-flags CHECK are exactly
 * what production applies.
 *
 * Pins the title-from-first-child arm: the first child's text becomes the
 * title, the child is trashed (one `page-blocks` ledger entry), its children
 * take its slot at the head of the page in order, every remaining row is
 * re-scoped into the new page, and an empty block is seeded.
 *
 * Run: `./singularity test plugins/page/plugins/editor`
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
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { TrashEntrySchema } from "@plugins/infra/plugins/trash/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { defineBlock, textBlockSchema } from "../../core";
import {
  pageBlockHandle,
  pageData,
  PAGE_BLOCKS_TRASH_SOURCE,
} from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { BlockLifecycle } from "./document-hooks";
import { turnBlockIntoPage } from "./handle-turn-into-page";

// Stand-ins for `page/text` and a void container (the concrete block plugins
// import this one, so importing them back would be a cycle).
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});
const cardStub = defineBlock({
  type: "card",
  schema: z.object({}),
  empty: () => ({}),
});

const SEED = { type: "text", data: { text: [] } };

let t: TestDb;
const trashCalls: string[][] = [];

beforeAll(async () => {
  t = await createTestDb({ prefix: "turn_into_page_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  collectContributions([
    {
      id: "turn-into-page-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
        Editor.BlockData(cardStub),
        BlockLifecycle.OnTrash({
          onTrash: (rows) => {
            trashCalls.push(rows.map((r) => r.id).sort());
          },
        }),
      ],
    },
  ]);
  trashCalls.length = 0;
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

async function seed(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type?: string;
  rank: string;
  text?: string;
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
        ? { title: args.id, icon: null }
        : type === "card"
          ? {}
          : { text: args.text ?? "" },
    ),
  });
}

/** Page `P` holding a void card `C` (rank a1) between two paragraphs. */
async function seedCard(): Promise<void> {
  await seed({
    id: "P",
    parentId: null,
    pageId: null,
    type: "page",
    rank: "a0",
  });
  await seed({ id: "before", parentId: "P", pageId: "P", rank: "a0" });
  await seed({ id: "C", parentId: "P", pageId: "P", type: "card", rank: "a1" });
  await seed({ id: "after", parentId: "P", pageId: "P", rank: "a2" });
}

/** Live children of `parentId`, in rank order. */
async function liveChildren(parentId: string) {
  const rows = await t.db.execute<{
    id: string;
    page_id: string | null;
    type: string;
    rank: string;
  }>(
    sql`SELECT id, page_id, type, rank FROM page_blocks
        WHERE parent_id = ${parentId} AND deleted_at IS NULL`,
  );
  return rows.rows.sort((a, b) =>
    Rank.compare(Rank.from(a.rank), Rank.from(b.rank)),
  );
}

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

async function entries() {
  return (await t.db.select().from(_trashEntries)).map((e) =>
    TrashEntrySchema.parse(e),
  );
}

describe("turn-into-page: title from the first child", () => {
  test("the first child's text is the title; the child is trashed; its children take its slot in order; the rest re-scope into the page", async () => {
    await seedCard();
    await seed({
      id: "L1",
      parentId: "C",
      pageId: "P",
      rank: "a0",
      text: "  My title ",
    });
    await seed({
      id: "G1",
      parentId: "L1",
      pageId: "P",
      rank: "a0",
      text: "g1",
    });
    await seed({
      id: "G2",
      parentId: "L1",
      pageId: "P",
      rank: "a1",
      text: "g2",
    });
    await seed({
      id: "L2",
      parentId: "C",
      pageId: "P",
      rank: "a1",
      text: "second",
    });
    await seed({
      id: "L2c",
      parentId: "L2",
      pageId: "P",
      rank: "a0",
      text: "deep",
    });

    const page = await turnBlockIntoPage(
      "C",
      {
        title: { fromFirstChild: true },
        seedChild: SEED,
        kind: { kind: "agent-page" },
      },
      t.db,
    );

    // The card is the page, in place: id, parent and rank kept.
    expect(page.id).toBe("C");
    expect(page.type).toBe("page");
    expect(page.parentId).toBe("P");
    expect(page.pageId).toBe("P");
    const data = pageData(page);
    expect(data.title).toBe("My title");
    expect(data.author).toBe("agent");
    expect((await liveChildren("P")).map((r) => r.id)).toEqual([
      "before",
      "C",
      "after",
    ]);

    // The title child is gone — a trash, under one `page-blocks` entry.
    const l1 = await row("L1");
    expect(l1.deletedAt).not.toBeNull();
    const all = await entries();
    expect(all).toHaveLength(1);
    expect(all[0]!.sourceId).toBe(PAGE_BLOCKS_TRASH_SOURCE);
    expect(l1.trashEntryId).toBe(all[0]!.id);
    expect(trashCalls).toEqual([["L1"]]);

    // Its children head the page, in their order, ahead of the next line; no
    // seed, since the page has content.
    const top = await liveChildren("C");
    expect(top.map((r) => r.id)).toEqual(["G1", "G2", "L2"]);
    for (const r of top) expect(r.page_id).toBe("C");
    expect((await row("L2c")).pageId).toBe("C");
    expect((await row("L2c")).parentId).toBe("L2");
  });

  test("a card holding only its first line becomes a titled page with one seeded line", async () => {
    await seedCard();
    await seed({
      id: "L1",
      parentId: "C",
      pageId: "P",
      rank: "a0",
      text: "Only line",
    });

    const page = await turnBlockIntoPage(
      "C",
      { title: { fromFirstChild: true }, seedChild: SEED },
      t.db,
    );

    expect(pageData(page).title).toBe("Only line");
    const top = await liveChildren("C");
    expect(top).toHaveLength(1);
    expect(top[0]!.id).not.toBe("L1");
    expect(top[0]!.type).toBe("text");
    expect(top[0]!.page_id).toBe("C");
    expect((await row("L1")).deletedAt).not.toBeNull();
  });

  test("an empty card becomes an untitled page with a seed, consuming nothing", async () => {
    await seedCard();

    const page = await turnBlockIntoPage(
      "C",
      { title: { fromFirstChild: true }, seedChild: SEED },
      t.db,
    );

    expect(pageData(page).title).toBe("");
    expect(await liveChildren("C")).toHaveLength(1);
    expect(await entries()).toEqual([]);
    expect(trashCalls).toEqual([]);
  });

  test("a first child holding no text is kept, and the page is untitled", async () => {
    await seedCard();
    await seed({
      id: "inner",
      parentId: "C",
      pageId: "P",
      type: "card",
      rank: "a0",
    });
    await seed({
      id: "x",
      parentId: "inner",
      pageId: "P",
      rank: "a0",
      text: "x",
    });

    const page = await turnBlockIntoPage(
      "C",
      { title: { fromFirstChild: true }, seedChild: SEED },
      t.db,
    );

    expect(pageData(page).title).toBe("");
    expect((await liveChildren("C")).map((r) => r.id)).toEqual(["inner"]);
    expect((await row("x")).pageId).toBe("C");
    expect(await entries()).toEqual([]);
  });

  test("a literal title consumes nothing", async () => {
    await seedCard();
    await seed({
      id: "L1",
      parentId: "C",
      pageId: "P",
      rank: "a0",
      text: "line",
    });

    const page = await turnBlockIntoPage(
      "C",
      { title: "Given", seedChild: SEED },
      t.db,
    );

    expect(pageData(page).title).toBe("Given");
    expect((await liveChildren("C")).map((r) => r.id)).toEqual(["L1"]);
    expect(await entries()).toEqual([]);
  });
});
