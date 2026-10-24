/**
 * Real-DB suite for the attachment-link reconcile (`applyLinkDiff`, the body of
 * `AttachmentLink.setMany` / `.set`). Headless: provisions a throwaway Postgres
 * (db-test-fixture), applies the REAL migration chain, and drives the
 * db-parametrized reconcile against a real link table — so the composite PK,
 * the batched `ON CONFLICT DO NOTHING` insert and the pair-wise `or(...)` delete
 * are exercised as production runs them, not as a fake `db` would report them.
 *
 * The load-bearing case is `issues NO write statements when nothing changed`:
 * the reconcile is bound to a ~1 s text-projection settle that touches no
 * attachment at all, so an unchanged page must cost one indexed SELECT and
 * nothing else. A statement-counting proxy is what makes "nothing else"
 * observable — row state alone cannot tell a skipped DELETE apart from a
 * delete-nothing one, and the STATEMENT-level change-feed trigger cannot
 * either, which is exactly why the distinction matters.
 *
 * Run: `./equin test plugins/infra/plugins/attachments`
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
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { applyLinkDiff, defineLink } from "./define-link";

// A minimal drizzle mapping onto the REAL migrated `agents` table — the owner
// whose `agents_attachments` link table the migration chain already creates.
// Only `id` is named because that is all `defineLink` reads from an owner.
const owners = pgTable("agents", { id: text("id").primaryKey() });

const link = defineLink(owners);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "att_link_test" });
  // The REAL schema via the real migration chain, so the composite primary key
  // and both cascading FKs are exactly what production applies.
  await runMigrations(t.db);
  // Owners and attachments both sit behind FKs, so the fixtures must exist
  // before any link row can.
  let rank = 0;
  for (const id of ["own-a", "own-b", "own-c"]) {
    await t.db.execute(
      sql`insert into agents (id, name, rank) values (${id}, ${id}, ${`a${rank++}`})`,
    );
  }
  for (const id of ["att-1", "att-2", "att-3"]) {
    await t.db.execute(
      sql`insert into attachments (id, filename, mime, size, disk_path)
          values (${id}, ${`${id}.png`}, 'image/png', 1, ${`/tmp/${id}`})`,
    );
  }
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(link.table);
});

/** Every (owner, attachment) pair currently stored, as sorted `owner/att` keys. */
async function storedPairs(): Promise<string[]> {
  const rows = await t.db
    .select({
      ownerId: link.table.ownerId,
      attachmentId: link.table.attachmentId,
    })
    .from(link.table);
  return rows.map((r) => `${r.ownerId}/${r.attachmentId}`).sort();
}

type StatementCounts = { select: number; insert: number; delete: number };

/**
 * The test db, wrapped so every `select` / `insert` / `delete` builder call is
 * counted. Methods are applied to the real handle, so the SQL that runs is
 * unchanged — only the tally is added.
 */
function countingDb(): { db: TestDb["db"]; counts: StatementCounts } {
  const counts: StatementCounts = { select: 0, insert: 0, delete: 0 };
  const db = new Proxy(t.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (
        (prop === "select" || prop === "insert" || prop === "delete") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          counts[prop] += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { db, counts };
}

describe("applyLinkDiff", () => {
  test("writes nothing at all when there are no entries", async () => {
    const { db, counts } = countingDb();
    await applyLinkDiff(db, link.table, []);
    expect(counts).toEqual({ select: 0, insert: 0, delete: 0 });
  });

  test("inserts a whole batch of owners in one statement", async () => {
    const { db, counts } = countingDb();
    await applyLinkDiff(db, link.table, [
      { ownerId: "own-a", ids: ["att-1", "att-2"] },
      { ownerId: "own-b", ids: ["att-2"] },
      // An owner declaring no attachments contributes nothing to the insert.
      { ownerId: "own-c", ids: [] },
    ]);

    expect(await storedPairs()).toEqual([
      "own-a/att-1",
      "own-a/att-2",
      "own-b/att-2",
    ]);
    expect(counts).toEqual({ select: 1, insert: 1, delete: 0 });
  });

  test("issues NO write statements when nothing changed", async () => {
    const entries = [
      { ownerId: "own-a", ids: ["att-1", "att-2"] },
      { ownerId: "own-b", ids: ["att-2"] },
      { ownerId: "own-c", ids: [] },
    ];
    await applyLinkDiff(t.db, link.table, entries);
    const before = await storedPairs();

    // The same reconcile again — the shape of every text-projection settle,
    // which changes no attachment link.
    const { db, counts } = countingDb();
    await applyLinkDiff(db, link.table, entries);

    expect(counts).toEqual({ select: 1, insert: 0, delete: 0 });
    expect(await storedPairs()).toEqual(before);
  });

  test("a mixed batch adds, removes, and leaves unchanged pairs alone", async () => {
    await applyLinkDiff(t.db, link.table, [
      { ownerId: "own-a", ids: ["att-1", "att-2"] },
      { ownerId: "own-b", ids: ["att-3"] },
    ]);

    const { db, counts } = countingDb();
    await applyLinkDiff(db, link.table, [
      // att-1 stays, att-2 goes, att-3 arrives.
      { ownerId: "own-a", ids: ["att-1", "att-3"] },
      // Cleared entirely by the empty-ids arm.
      { ownerId: "own-b", ids: [] },
    ]);

    expect(await storedPairs()).toEqual(["own-a/att-1", "own-a/att-3"]);
    // One batched insert and one batched delete, however many owners changed.
    expect(counts).toEqual({ select: 1, insert: 1, delete: 1 });
  });

  test("never touches an owner outside the batch", async () => {
    await applyLinkDiff(t.db, link.table, [
      { ownerId: "own-a", ids: ["att-1"] },
      { ownerId: "own-c", ids: ["att-3"] },
    ]);

    // own-c is not mentioned, so its row must survive a full clear of own-a.
    await applyLinkDiff(t.db, link.table, [{ ownerId: "own-a", ids: [] }]);

    expect(await storedPairs()).toEqual(["own-c/att-3"]);
  });

  test("deduplicates repeated ids within one owner's set", async () => {
    const { db, counts } = countingDb();
    await applyLinkDiff(db, link.table, [
      { ownerId: "own-a", ids: ["att-1", "att-1", "att-2"] },
    ]);

    expect(await storedPairs()).toEqual(["own-a/att-1", "own-a/att-2"]);
    expect(counts.insert).toBe(1);
  });
});
