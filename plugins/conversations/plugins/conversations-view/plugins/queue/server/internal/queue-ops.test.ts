/**
 * Real-DB suite for the queue's section writes: the REAL migration chain on a
 * throwaway database (db-test-fixture), every op run in its own transaction as
 * the handlers run it.
 *
 * Requires the running embedded cluster and the `conversation_sections`
 * migration (`./equin build` first):
 *   ./equin test plugins/conversations/plugins/conversations-view/plugins/queue
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PINNED_SECTION,
  conversationSectionIdKind,
  type ConversationSectionId,
} from "../../core";
import { conversationsQueue, _conversationSections } from "./tables";
import {
  createSection,
  deleteSection,
  fileGroup,
  moveSection,
  renameSection,
  reorderGroup,
  type FiledConversation,
} from "./queue-ops";

const OLD = "2000-01-01T00:00:00.000Z";
let t: TestDb;
let seq = 0;

type Exec = Parameters<typeof fileGroup>[0];
function inTx<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
  return t.db.transaction((tx) => fn(tx));
}

async function seedTask(): Promise<string> {
  const id = `q-task-${++seq}`;
  await t.db.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, created_at, updated_at, mandate_ref)
    VALUES (${id}, ${id}, 'a', true, ${id}, ${OLD}, ${OLD}, 'interactive')
  `);
  return id;
}

/** A waiting conversation of `taskId` (a fresh task when absent). */
async function seedConversation(taskId?: string): Promise<FiledConversation> {
  const task = taskId ?? (await seedTask());
  const n = ++seq;
  const attemptId = `q-att-${n}`;
  const id = `q-conv-${n}`;
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path, created_at, updated_at)
    VALUES (${attemptId}, ${task}, '/tmp/x', ${OLD}, ${OLD})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, title, status, runtime, model, kind, created_at, updated_at)
    VALUES (${id}, ${attemptId}, 'a', 'waiting', 'sdk', 'opus', 'user', ${OLD}, ${OLD})
  `);
  return { conversationId: id, taskId: task };
}

async function ranked(conv: FiledConversation, rank: Rank): Promise<void> {
  await t.db.insert(conversationsQueue.table).values({
    conversationId: conv.conversationId,
    rank: rank.toJSON(),
    section: null,
  });
}

async function queueRow(conversationId: string) {
  const [row] = await t.db
    .select({
      rank: conversationsQueue.table.rank,
      section: conversationsQueue.table.section,
    })
    .from(conversationsQueue.table)
    .where(eq(conversationsQueue.table.conversationId, conversationId));
  return row;
}

async function sectionNames(): Promise<string[]> {
  const rows = await t.db
    .select({ name: _conversationSections.name })
    .from(_conversationSections)
    .orderBy(asc(_conversationSections.rank));
  return rows.map((r) => r.name);
}

async function expectHttp(p: Promise<unknown>, status: number): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
}

const unknownId = (): ConversationSectionId => conversationSectionIdKind.mint();

beforeAll(async () => {
  t = await createTestDb({ prefix: "queue_sections_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(conversationsQueue.table);
  await t.db.delete(_conversationSections);
});

describe("fileGroup", () => {
  test("files the whole task group, keeps the rank, and back to the Queue", async () => {
    const a = await seedConversation();
    const sibling = await seedConversation(a.taskId);
    const r = Rank.between(null, null);
    await ranked(a, r);
    await ranked(sibling, r);

    await inTx((tx) => fileGroup(tx, a, PINNED_SECTION));
    expect(await queueRow(a.conversationId)).toEqual({
      rank: r.toJSON(),
      section: PINNED_SECTION,
    });
    expect((await queueRow(sibling.conversationId))?.section).toBe(
      PINNED_SECTION,
    );

    await inTx((tx) => fileGroup(tx, a, null));
    expect(await queueRow(a.conversationId)).toEqual({
      rank: r.toJSON(),
      section: null,
    });
    expect((await queueRow(sibling.conversationId))?.section).toBeNull();
  });

  test("seeds a rank for an unranked conversation filed into a section", async () => {
    const a = await seedConversation();
    await inTx((tx) => fileGroup(tx, a, PINNED_SECTION));
    const row = await queueRow(a.conversationId);
    expect(row?.section).toBe(PINNED_SECTION);
    expect(typeof row?.rank).toBe("string");
  });

  test("an unknown user section is a 404, and nothing is written", async () => {
    const a = await seedConversation();
    await ranked(a, Rank.between(null, null));
    await expectHttp(
      inTx((tx) => fileGroup(tx, a, unknownId())),
      404,
    );
    expect((await queueRow(a.conversationId))?.section).toBeNull();
  });

  test("files into a user section", async () => {
    const a = await seedConversation();
    await ranked(a, Rank.between(null, null));
    const id = await inTx((tx) => createSection(tx, { name: "Later" }));
    await inTx((tx) => fileGroup(tx, a, id));
    expect((await queueRow(a.conversationId))?.section).toBe(id);
  });
});

describe("reorderGroup", () => {
  test("with a section, moves next to the target and files in one go", async () => {
    const a = await seedConversation();
    const b = await seedConversation();
    const r1 = Rank.between(null, null);
    const r2 = Rank.between(r1, null);
    await ranked(a, r1);
    await ranked(b, r2);
    await inTx((tx) => fileGroup(tx, b, PINNED_SECTION));

    await inTx((tx) =>
      reorderGroup(tx, {
        conversationId: a.conversationId,
        targetId: b.conversationId,
        zone: "after",
        section: PINNED_SECTION,
      }),
    );
    const row = await queueRow(a.conversationId);
    expect(row?.section).toBe(PINNED_SECTION);
    expect(Rank.compare(Rank.from(row!.rank), r2)).toBe(1);
  });

  test("without a section, the section is untouched", async () => {
    const a = await seedConversation();
    const b = await seedConversation();
    await ranked(a, Rank.between(null, null));
    await ranked(b, Rank.between(Rank.between(null, null), null));
    await inTx((tx) => fileGroup(tx, a, PINNED_SECTION));
    await inTx((tx) =>
      reorderGroup(tx, {
        conversationId: a.conversationId,
        targetId: b.conversationId,
        zone: "after",
      }),
    );
    expect((await queueRow(a.conversationId))?.section).toBe(PINNED_SECTION);
  });

  test("an unknown section is a 404", async () => {
    const a = await seedConversation();
    const b = await seedConversation();
    await ranked(a, Rank.between(null, null));
    await ranked(b, Rank.between(Rank.between(null, null), null));
    await expectHttp(
      inTx((tx) =>
        reorderGroup(tx, {
          conversationId: a.conversationId,
          targetId: b.conversationId,
          zone: "after",
          section: unknownId(),
        }),
      ),
      404,
    );
  });
});

describe("sections", () => {
  test("create: last by default, after a section, first after Pinned", async () => {
    const a = await inTx((tx) => createSection(tx, { name: " A " }));
    await inTx((tx) => createSection(tx, { name: "C" }));
    await inTx((tx) => createSection(tx, { name: "B", after: a }));
    await inTx((tx) =>
      createSection(tx, { name: "Head", after: PINNED_SECTION }),
    );
    expect(await sectionNames()).toEqual(["Head", "A", "B", "C"]);
  });

  test("create rejects an empty name (400) and an unknown `after` (404)", async () => {
    await expectHttp(
      inTx((tx) => createSection(tx, { name: "   " })),
      400,
    );
    await expectHttp(
      inTx((tx) => createSection(tx, { name: "X", after: unknownId() })),
      404,
    );
    expect(await sectionNames()).toEqual([]);
  });

  test("create with a conversation files its group into the new section", async () => {
    const a = await seedConversation();
    const id = await inTx((tx) =>
      createSection(tx, { name: "New", conversation: a }),
    );
    expect((await queueRow(a.conversationId))?.section).toBe(id);
  });

  test("rename trims, rejects empty (400) and unknown ids (404)", async () => {
    const id = await inTx((tx) => createSection(tx, { name: "Old" }));
    await inTx((tx) => renameSection(tx, id, "  New  "));
    expect(await sectionNames()).toEqual(["New"]);
    await expectHttp(
      inTx((tx) => renameSection(tx, id, " ")),
      400,
    );
    await expectHttp(
      inTx((tx) => renameSection(tx, unknownId(), "X")),
      404,
    );
  });

  test("move places a section next to another", async () => {
    const a = await inTx((tx) => createSection(tx, { name: "A" }));
    await inTx((tx) => createSection(tx, { name: "B" }));
    const c = await inTx((tx) => createSection(tx, { name: "C" }));
    await inTx((tx) => moveSection(tx, { id: c, targetId: a, zone: "before" }));
    expect(await sectionNames()).toEqual(["C", "A", "B"]);
    await inTx((tx) => moveSection(tx, { id: c, targetId: a, zone: "after" }));
    expect(await sectionNames()).toEqual(["A", "C", "B"]);
    await expectHttp(
      inTx((tx) =>
        moveSection(tx, { id: unknownId(), targetId: a, zone: "after" }),
      ),
      404,
    );
  });

  test("delete returns its members to the Queue", async () => {
    const a = await seedConversation();
    const id = await inTx((tx) =>
      createSection(tx, { name: "S", conversation: a }),
    );
    await inTx((tx) => deleteSection(tx, id));
    expect(await sectionNames()).toEqual([]);
    expect((await queueRow(a.conversationId))?.section).toBeNull();
    await expectHttp(
      inTx((tx) => deleteSection(tx, id)),
      404,
    );
  });
});
