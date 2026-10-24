/**
 * Real-DB suite for the DESTINATION-PARENT LIVENESS GUARD — the write-boundary
 * refusal that makes "a live block whose `parent_id` names a trashed row"
 * unreachable. Drives the two db-parametrized chokepoints every parent-accepting
 * write path must go through against a throwaway Postgres (db-test-fixture) with
 * the REAL migration chain, so the soft-delete columns and the partial unique
 * indexes are exactly what production applies:
 *
 *  - `requireLiveParent` / `computePageId` — the INSERT paths (create) cannot
 *    write a row without resolving its `page_id`.
 *  - `loadLiveSiblings` — the REPARENT paths (move, bulk-move) cannot mint a
 *    rank without reading the destination sibling set.
 *
 * The handlers themselves bind the module-level `db` singleton and so cannot be
 * pointed at a fixture DB; the chokepoints are the seam they all funnel through
 * (`handle-set-row-order.test.ts` drives `applyRowOrder` for the same reason).
 * The last block covers the cascade contract the guard completes, through the
 * real `deleteBlocksSubtree`.
 *
 * Run: `bun test plugins/page/plugins/editor/server/internal/parent-liveness.test.ts`
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
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import { defineBlock } from "../../core";
import { pageBlockHandle } from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { computePageId, requireLiveParent } from "./page-id";
import { loadLiveSiblings } from "./forest";
import { deleteBlocksSubtree } from "./trash-blocks";

// Stand-in for `page/text` — the concrete block plugin imports this one, so
// importing it back would be a cycle (same fixture as `trash-blocks.test.ts`).
const textBlockStub = defineBlock({
  type: "text",
  schema: z.object({}),
  empty: () => ({}),
});

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "parent_liveness_test" });
  await runMigrations(t.db);
  collectContributions([
    {
      id: "parent-liveness-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
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

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  return r;
}

/** Every row's `(parentId, rank, deletedAt)` — the snapshot a rejected write must not disturb. */
async function snapshot(): Promise<string> {
  const rows = await t.db.select().from(_blocks);
  return JSON.stringify(
    rows
      .map((r) => [
        r.id,
        r.parentId,
        r.pageId,
        r.rank,
        r.deletedAt?.toISOString() ?? null,
      ])
      .sort(),
  );
}

/**
 * W (root page) ⊃ A (sub-page, trashed) and L (sub-page, live). `A1` is A's
 * content. Trashing A gives us a real trashed row — flagged by the real
 * chokepoint, not a hand-set column.
 */
async function seedTrashedParent(): Promise<void> {
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
    id: "A1",
    parentId: "A",
    pageId: "A",
    type: "text",
    rank: "a0",
  });
  await seedBlock({
    id: "L",
    parentId: "W",
    pageId: "W",
    type: "page",
    rank: "a1",
  });
  await deleteBlocksSubtree(["A"], t.db);
}

// ── The guard itself ───────────────────────────────────────────────────────

describe("requireLiveParent", () => {
  test("a TRASHED parent is 404 — not addressable", async () => {
    await seedTrashedParent();
    expect((await row("A"))?.deletedAt).toBeInstanceOf(Date); // really trashed

    const err = await requireLiveParent("A", t.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  test("a MISSING parent is 404", async () => {
    await seedTrashedParent();
    const err = await requireLiveParent("nope", t.db).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
  });

  test("a LIVE parent resolves, and null (workspace root) stays legal", async () => {
    await seedTrashedParent();
    expect(await requireLiveParent("L", t.db)).toEqual({
      id: "L",
      type: "page",
      pageId: "W",
    });
    expect(await requireLiveParent(null, t.db)).toBeNull();
  });
});

// ── The INSERT chokepoint (create) ─────────────────────────────────────────

describe("computePageId — the insert paths' guard", () => {
  test("rejects a trashed destination parent with 404, writing nothing", async () => {
    await seedTrashedParent();
    const before = await snapshot();

    const err = await computePageId("A", t.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  test("a trashed CONTENT block is refused too, not just a trashed page", async () => {
    // Trash A: its content A1 is flagged with it (the cross-page cascade), so a
    // block parented to A1 would dangle exactly the same way.
    await seedTrashedParent();
    expect((await row("A1"))?.deletedAt).toBeInstanceOf(Date);

    const err = await computePageId("A1", t.db).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
  });

  test("a live parent still resolves its page scope (no regression)", async () => {
    await seedTrashedParent();
    await seedBlock({
      id: "L1",
      parentId: "L",
      pageId: "L",
      type: "text",
      rank: "a0",
    });

    expect(await computePageId("L", t.db)).toBe("L"); // parent IS the page
    expect(await computePageId("L1", t.db)).toBe("L"); // inherit the parent's page
    expect(await computePageId(null, t.db)).toBeNull(); // workspace root
  });
});

// ── The REPARENT chokepoint (move / bulk-move) ─────────────────────────────

describe("loadLiveSiblings — the move paths' guard", () => {
  test("rejects a trashed destination parent with 404, writing nothing", async () => {
    await seedTrashedParent();
    const before = await snapshot();

    const err = await loadLiveSiblings(t.db, "A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  test("a live parent returns its complete live sibling set (no regression)", async () => {
    await seedTrashedParent();
    await seedBlock({
      id: "L1",
      parentId: "L",
      pageId: "L",
      type: "text",
      rank: "a0",
    });
    await seedBlock({
      id: "L2",
      parentId: "L",
      pageId: "L",
      type: "page",
      rank: "a1",
    });

    const { siblings } = await loadLiveSiblings(t.db, "L");
    // Unfiltered by `type` and by `page_id` — one ordering space.
    expect(siblings.map((s) => s.id).sort()).toEqual(["L1", "L2"]);
  });

  test("parentId null (workspace root) is legal and lists live root rows only", async () => {
    await seedTrashedParent();
    await seedBlock({
      id: "R",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a1",
    });
    await deleteBlocksSubtree(["R"], t.db);

    const { siblings: roots } = await loadLiveSiblings(t.db, null);
    expect(roots.map((s) => s.id)).toEqual(["W"]); // R is trashed, W is not
  });

  test("hands back the RESOLVED destination row, so a caller never re-queries it", async () => {
    // `handle-move-block` reads `parent.type` off this to decide whether the
    // destination is a page row (which a move must never open). Re-reading it
    // outside the lock would let a concurrent writer change the answer.
    await seedTrashedParent();

    const under = await loadLiveSiblings(t.db, "L");
    expect(under.parent).toEqual({ id: "L", type: "page", pageId: "W" });

    const atRoot = await loadLiveSiblings(t.db, null);
    expect(atRoot.parent).toBeNull(); // the workspace root is not a row
  });

  test("a trashed sibling is excluded from the rank window", async () => {
    // The partial unique index lets a trashed row share a live row's rank;
    // including it would abort the rank math with `Rank.between(r, r)`.
    await seedTrashedParent();
    const { siblings: underW } = await loadLiveSiblings(t.db, "W");
    expect(underW.map((s) => s.id)).toEqual(["L"]); // A is trashed
  });
});

// ── The cascade contract the guard completes ───────────────────────────────

describe("delete cascade across a page boundary", () => {
  test("pages A ⊂ B: deleting B trashes A too, under B's single trash entry", async () => {
    await seedBlock({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seedBlock({
      id: "B",
      parentId: "W",
      pageId: "W",
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
    // A is a sub-page of B — a DIFFERENT `page_id` partition, reached only
    // because `collectBlockSubtrees` walks `parent_id` across page boundaries.
    await seedBlock({
      id: "A",
      parentId: "B",
      pageId: "B",
      type: "page",
      rank: "a1",
    });
    await seedBlock({
      id: "A1",
      parentId: "A",
      pageId: "A",
      type: "text",
      rank: "a0",
    });

    const result = await deleteBlocksSubtree(["B"], t.db);
    expect(result.trashed).toBe(true);

    // ONE entry, rooted at B — A is not independently listed in the trash.
    const entries = await t.db.select().from(_trashEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.rootEntityId).toBe("B");

    // A is trashed WITH B, under B's entry: never left live under a trashed
    // parent, which is the state the write guard now also refuses to create.
    for (const id of ["B", "B1", "A", "A1"]) {
      const r = await row(id);
      expect(r?.deletedAt).toBeInstanceOf(Date);
      expect(r?.trashEntryId).toBe(entries[0]!.id);
    }
    expect((await row("W"))?.deletedAt).toBeNull();

    // And the guard now refuses to re-create the dangling state by hand.
    const err = await computePageId("A", t.db).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(404);
  });
});
