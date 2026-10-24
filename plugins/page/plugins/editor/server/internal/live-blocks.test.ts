/**
 * Real-DB proof for the `liveBlocks` relation (`live-blocks.ts`): the subquery
 * alias must lose NOTHING a reader relies on from `_blocks`.
 *
 *  1. The custom column decoders survive the alias — `rank_text` (a
 *     `customType`) and `data` (`parsedJson`, which parses on every read) — so a
 *     row read through `liveBlocks` is byte-for-byte the row read through
 *     `_blocks`.
 *  2. The trashed rows are gone, and the predicate was never written by the
 *     reader.
 *  3. The rendered SQL still names `"page_blocks"` after a `from` keyword —
 *     the live-state read-set extractor (`database/server/internal/client.ts`)
 *     matches base tables by regex, which is why this is a subquery and not a
 *     DB view. (The extractor is module-private to the database plugin, so the
 *     assertion is on the SQL text it would see.)
 *
 * Run: `./equin test plugins/page/plugins/editor`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { _blocks } from "./tables";
import { liveBlocks } from "./live-blocks";
import { BLOCK_WIRE_COLUMNS } from "./wire-columns";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "live_blocks_test" });
  await runMigrations(t.db);
  // Two live root blocks and one trashed one. Raw SQL: the point is to read
  // back through drizzle what Postgres holds, not what a drizzle write encoded.
  // `rank` values are deliberately mixed-case: `rank_text` is a C-collation
  // domain, so `"Z" < "a"`, which the ORDER BY below depends on.
  await t.db.execute(sql`
    INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank, expanded, deleted_at, trash_entry_id)
    VALUES
      ('live-a', NULL, NULL, 'text', '{"text":[{"t":"alpha"}]}', 'a0', true, NULL, NULL),
      ('live-b', NULL, NULL, 'text', '{"text":[{"t":"beta"}]}',  'Zz', false, NULL, NULL),
      ('gone',   NULL, NULL, 'text', '{"text":[{"t":"gone"}]}',  'a1', true, now(), 'entry-1')
  `);
});

afterAll(async () => {
  await t.drop();
});

describe("liveBlocks", () => {
  test("a full-row read decodes exactly like the base table, minus trashed rows", async () => {
    const live = await t.db
      .select()
      .from(liveBlocks)
      .orderBy(asc(liveBlocks.rank));
    const base = await t.db.select().from(_blocks).orderBy(asc(_blocks.rank));

    expect(live.map((r) => r.id)).toEqual(["live-b", "live-a"]); // C collation: "Zz" < "a0"
    expect(base.map((r) => r.id)).toEqual(["live-b", "live-a", "gone"]);
    // Same decoders: `data` is the parsed object (not a string), `rank` the
    // stored text, timestamps real Dates — identical to the base-table read.
    expect(live).toEqual(base.filter((r) => r.deletedAt === null));
    expect<unknown>(live[0]!.data).toEqual({ text: [{ t: "beta" }] });
    expect(live[0]!.createdAt).toBeInstanceOf(Date);
    expect(live[0]!.deletedAt).toBeNull();
  });

  test("the wire projection reads through the live relation", async () => {
    const rows = await t.db
      .select(BLOCK_WIRE_COLUMNS)
      .from(liveBlocks)
      .orderBy(asc(liveBlocks.rank));
    expect(rows.map((r) => r.id)).toEqual(["live-b", "live-a"]);
    expect<unknown>(rows[1]!.data).toEqual({ text: [{ t: "alpha" }] });
    expect(rows[1]!.rank).toBe("a0");
    expect(rows[1]!.expanded).toBe(true);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "createdAt",
      "data",
      "expanded",
      "id",
      "pageId",
      "parentId",
      "rank",
      "type",
      "updatedAt",
    ]);
  });

  test("a column predicate on the alias is applied to the live rows", async () => {
    const [row] = await t.db
      .select({ id: liveBlocks.id })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, "gone"));
    expect(row).toBeUndefined();
    const [alpha] = await t.db
      .select({ id: liveBlocks.id, rank: liveBlocks.rank })
      .from(liveBlocks)
      .where(eq(liveBlocks.rank, "a0"));
    expect(alpha).toEqual({ id: "live-a", rank: "a0" });
  });

  test("the rendered SQL still names the base table for the read-set extractor", () => {
    const { sql: text } = t.db
      .select({ id: liveBlocks.id })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, "x"))
      .toSQL();
    expect(text).toContain('from "page_blocks"');
    expect(text).toContain('"page_blocks"."deleted_at" is null');
    // The outer clause is `from (select …) "live_blocks"` — a parenthesis, not
    // a quoted identifier — so the extractor's `from "<table>"` match sees the
    // base table once and the alias never.
    expect(text).not.toContain('from "live_blocks"');

    // A join through the alias, too — the second way a reader reaches it.
    const joined = t.db
      .select({ id: liveBlocks.id })
      .from(_blocks)
      .innerJoin(liveBlocks, eq(liveBlocks.id, _blocks.parentId))
      .toSQL().sql;
    expect(joined).toContain('from "page_blocks"');
    expect(joined).not.toContain('join "live_blocks"');
  });
});
