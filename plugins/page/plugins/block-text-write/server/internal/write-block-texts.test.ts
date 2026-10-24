/**
 * Real-DB suite for `writeBlockTexts` — the one server-side text channel —
 * driven against a throwaway Postgres (db-test-fixture) with the REAL migration
 * chain, so the `page_block_docs` FK, the first-writer-wins seed and the patch
 * writer are exactly what production runs.
 *
 * What it pins:
 *  - every doc lands BEFORE the row projection, and a failed doc write leaves
 *    every row unprojected (the row never reads text its doc does not hold);
 *  - N edits cost ONE projection patch (one transaction: one `xmin`);
 *  - a doc-less block whose row already reads the target is left completely
 *    alone — no `page_block_docs` row minted, no row write;
 *  - a doc-less block whose row differs is seeded, then projected;
 *  - a row already reading the target is not rewritten, and a re-run writes
 *    nothing at all.
 *
 * Ordering and batching are read off Postgres' own `xmin` (the id of the
 * transaction that last wrote a row): rows written by one patch share it, and a
 * transaction that wrote earlier holds a smaller one.
 *
 * Run: `./equin test plugins/page/plugins/block-text-write`
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
import { sql } from "drizzle-orm";
import { encodeStateAsUpdate } from "yjs";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { tokenExtension } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { defineInlineTokenNode } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/plugins/node/core";
import {
  initBlockDoc,
  loadBlockDocs,
} from "@plugins/page/plugins/editor-collab/server";
import { Editor } from "@plugins/page/plugins/editor/server";
import {
  defineBlock,
  pageBlockHandle,
  plainOf,
  runsOf,
  runsOfNode,
  runsToXmlText,
  textBlockSchema,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { readStateRuns } from "./block-doc-text";
import { writeBlockTexts } from "./write-block-texts";

// Stand-in for `page/text` (importing the concrete block plugin would pull in
// its web half). Text-bearing, so the projection's `data.text` is validated.
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

// A decorator family nothing contributes a server node for — a doc holding one
// is refused by `readStateRuns`, which is how a doc write is made to FAIL.
const orphanNode = defineInlineTokenNode<{ id: string }>({
  type: "orphan-token",
  fields: ["id"],
  token: ({ id }) => `<<${id}>>`,
  fieldsOf: (match) => ({ id: match[1]! }),
  textContent: "empty",
});
const orphanExtension = tokenExtension({
  id: "orphan",
  pattern: /<<([a-z0-9]+)>>/,
  node: orphanNode,
});

const PAGE = "page-under-test";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "block_text_write_test" });
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
      id: "write-block-texts-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
      ],
    },
  ]);
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, type, rank, data)
        VALUES (${PAGE}, 'page', 'a0', ${JSON.stringify({ title: "P", icon: null })}::jsonb)`,
  );
});

// ── Helpers ────────────────────────────────────────────────────────────────

let nextBlock = 0;

/** A live text block of {@link PAGE} whose row reads `runs`. No doc. */
async function seedBlock(runs: RichText): Promise<string> {
  const id = `block-${++nextBlock}`;
  // Unique per test run: live siblings may not share a `(parent_id, rank)`.
  const rank = `b${nextBlock.toString(36).padStart(2, "0")}`;
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
        VALUES (${id}, ${PAGE}, ${PAGE}, 'text', ${rank},
                ${JSON.stringify({ text: runs })}::jsonb)`,
  );
  return id;
}

/** Store a content doc for `blockId` holding `runs` (tokens per `extensions`). */
async function seedDoc(
  blockId: string,
  runs: RichText,
  extensions: readonly ReturnType<typeof tokenExtension>[] = [],
): Promise<void> {
  const xmlText = runsToXmlText(runs, {
    extensions,
    nodes: extensions.map((e) => e.node.Node),
  });
  await initBlockDoc(t.db, blockId, encodeStateAsUpdate(xmlText.doc!));
}

/** The plain text a block's stored doc holds, or `undefined` for no doc. */
async function docText(blockId: string): Promise<string | undefined> {
  const state = (await loadBlockDocs(t.db, [blockId])).get(blockId);
  return state === undefined
    ? undefined
    : plainOf(readStateRuns(state, blockId));
}

/** The plain text a block's row `data.text` reads. */
async function rowText(blockId: string): Promise<string> {
  const res = await t.db.execute<{ data: unknown }>(
    sql`SELECT data FROM page_blocks WHERE id = ${blockId}`,
  );
  return plainOf(runsOfNode(res.rows[0]!));
}

/** The id of the transaction that last wrote the row (see the header). */
async function xmin(
  table: "page_blocks" | "page_block_docs",
  blockId: string,
): Promise<bigint> {
  const res = await t.db.execute<{ x: string }>(
    table === "page_blocks"
      ? sql`SELECT xmin::text AS x FROM page_blocks WHERE id = ${blockId}`
      : sql`SELECT xmin::text AS x FROM page_block_docs WHERE block_id = ${blockId}`,
  );
  return BigInt(res.rows[0]!.x);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("writeBlockTexts", () => {
  test("splices every doc first, then projects all N rows in ONE patch", async () => {
    const a = await seedBlock(runsOf("alpha"));
    const b = await seedBlock(runsOf("bravo"));
    const c = await seedBlock(runsOf("charlie"));
    await seedDoc(a, runsOf("alpha"));
    await seedDoc(b, runsOf("bravo"));
    await seedDoc(c, runsOf("charlie"));

    await writeBlockTexts(
      PAGE,
      [
        { blockId: a, runs: runsOf("alpha one") },
        { blockId: b, runs: runsOf("bravo two") },
        { blockId: c, runs: runsOf("charlie three") },
      ],
      t.db,
    );

    expect(await docText(a)).toBe("alpha one");
    expect(await docText(b)).toBe("bravo two");
    expect(await docText(c)).toBe("charlie three");
    expect(await rowText(a)).toBe("alpha one");
    expect(await rowText(b)).toBe("bravo two");
    expect(await rowText(c)).toBe("charlie three");

    // One projection patch: all three rows written by one transaction.
    const rowTx = await xmin("page_blocks", a);
    expect(await xmin("page_blocks", b)).toBe(rowTx);
    expect(await xmin("page_blocks", c)).toBe(rowTx);
    // …which began after every doc write had committed.
    for (const id of [a, b, c]) {
      expect(await xmin("page_block_docs", id)).toBeLessThan(rowTx);
    }
  });

  test("a failed doc write leaves every row unprojected", async () => {
    const a = await seedBlock(runsOf("alpha"));
    const b = await seedBlock(runsOf("bravo <<zz>>"));
    await seedDoc(a, runsOf("alpha"));
    // A browser-written doc holding a decorator this composition has no server
    // node for: `readStateRuns` refuses it, so b's doc write throws.
    await seedDoc(b, runsOf("bravo <<zz>>"), [orphanExtension]);

    let caught: unknown;
    try {
      await writeBlockTexts(
        PAGE,
        [
          { blockId: a, runs: runsOf("alpha new") },
          { blockId: b, runs: runsOf("bravo new") },
        ],
        t.db,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain(`content doc of block ${b}`);
    expect(String((err.cause as Error).message)).toContain("orphan-token");

    // a's doc landed; its row did not — the doc may run ahead of its
    // projection, never the reverse. b is untouched.
    expect(await docText(a)).toBe("alpha new");
    expect(await rowText(a)).toBe("alpha");
    expect(await rowText(b)).toBe("bravo <<zz>>");
  });

  test("a doc-less block whose row already reads the target is left completely alone", async () => {
    // Stored uncoalesced: the equality is over CANONICAL runs, so a row whose
    // runs merely split differently still reads the target.
    const a = await seedBlock([{ text: "sa" }, { text: "me" }]);
    const before = await xmin("page_blocks", a);

    await writeBlockTexts(PAGE, [{ blockId: a, runs: runsOf("same") }], t.db);

    expect(await docText(a)).toBeUndefined(); // no page_block_docs row minted
    expect(await xmin("page_blocks", a)).toBe(before); // no row write
  });

  test("a doc-less block whose row differs is seeded, then projected", async () => {
    const a = await seedBlock(runsOf("old"));

    await writeBlockTexts(PAGE, [{ blockId: a, runs: runsOf("new") }], t.db);

    expect(await docText(a)).toBe("new");
    expect(await rowText(a)).toBe("new");
    expect(await xmin("page_block_docs", a)).toBeLessThan(
      await xmin("page_blocks", a),
    );
  });

  test("a row already reading the target is not rewritten, while its doc still is", async () => {
    const a = await seedBlock(runsOf("target"));
    await seedDoc(a, runsOf("elsewhere"));
    const before = await xmin("page_blocks", a);

    await writeBlockTexts(PAGE, [{ blockId: a, runs: runsOf("target") }], t.db);

    expect(await docText(a)).toBe("target");
    expect(await xmin("page_blocks", a)).toBe(before);
  });

  test("re-running the same write writes nothing", async () => {
    const a = await seedBlock(runsOf("alpha"));
    const b = await seedBlock(runsOf("bravo"));
    await seedDoc(a, runsOf("alpha"));
    const edits = [
      { blockId: a, runs: runsOf("alpha one") },
      { blockId: b, runs: runsOf("bravo two") },
    ];
    await writeBlockTexts(PAGE, edits, t.db);
    const stamps = await Promise.all([
      xmin("page_blocks", a),
      xmin("page_blocks", b),
      xmin("page_block_docs", a),
      xmin("page_block_docs", b),
    ]);

    await writeBlockTexts(PAGE, edits, t.db);

    expect(
      await Promise.all([
        xmin("page_blocks", a),
        xmin("page_blocks", b),
        xmin("page_block_docs", a),
        xmin("page_block_docs", b),
      ]),
    ).toEqual(stamps);
  });

  test("a block that is not live on the page is refused before anything is written", async () => {
    const a = await seedBlock(runsOf("alpha"));
    await seedDoc(a, runsOf("alpha"));

    // bun's `expect(...).rejects` is not a thenable in its typings, so the
    // rejection is caught by hand (the same shape as trash-blocks.test.ts).
    let caught: unknown;
    try {
      await writeBlockTexts(
        PAGE,
        [
          { blockId: a, runs: runsOf("alpha new") },
          { blockId: "no-such-block", runs: runsOf("ghost") },
        ],
        t.db,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /no-such-block are not live blocks of page/,
    );

    expect(await docText(a)).toBe("alpha");
    expect(await rowText(a)).toBe("alpha");
  });

  test("naming one block twice is refused", async () => {
    const a = await seedBlock(runsOf("alpha"));
    let caught: unknown;
    try {
      await writeBlockTexts(
        PAGE,
        [
          { blockId: a, runs: runsOf("one") },
          { blockId: a, runs: runsOf("two") },
        ],
        t.db,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/more than once/);
    expect(await docText(a)).toBeUndefined();
  });
});
