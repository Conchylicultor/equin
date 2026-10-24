/**
 * The engine's writes against a real Postgres: a throwaway database
 * (db-test-fixture) with the real migration chain applied (the `rank_text`
 * C-collation domain), plus a test-only tree and one single-tag carrier
 * created here. Drives the db-parametrized repo functions the handlers call.
 *
 * Requires the running embedded cluster (`./equin build` first).
 * Run: `./equin test plugins/tag-tree`.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { defineIdKind } from "@plugins/ids/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineTagTree, tagTreeEntityRef } from "../../core/internal/declare";
import { defineTagTreeTable } from "./table";
import {
  resolveServedTree,
  serveTagTree,
  singleTagCarrier,
  type ServedTagTree,
  type TagTreeDb,
} from "./serve";
import {
  createTagIn,
  createTagPathIn,
  deleteTagIn,
  moveTagIn,
  updateTagIn,
} from "./repo";

setDefaultTimeout(120_000);

// ── A test-only tree: one extra (`note`, editable) and one carrier ─────────

const testTagIdKind = defineIdKind({ prefix: "tttag", label: "Test tag" });
const testTagsRef = tagTreeEntityRef("tag_tree_test_tags", {
  idKind: testTagIdKind,
  extraFields: { note: textField({ label: "Note" }) },
});
const testTags = liveCollection("tag-tree.test-tags.all", {
  from: testTagsRef,
  pick: ["name", "note"],
  carry: {
    pick: [
      "id",
      "parentId",
      "color",
      "childColors",
      "icon",
      "rank",
      "createdAt",
      "updatedAt",
    ],
  },
  id: "id",
  all: {
    orderBy: [["rank", "asc"]],
    unbounded: { reason: "a test tree, read whole" },
  },
});
const testTree = defineTagTree({
  id: "test-tree",
  entity: testTagsRef,
  collection: testTags,
});
const { table: testTagsTable } = defineTagTreeTable(testTagsRef, {
  columns: { note: { default: "" } },
  touchedBy: { note: true },
});
const items = pgTable("tag_tree_test_items", {
  id: text("id").primaryKey(),
  tagId: text("tag_id"),
});

const served: ServedTagTree = serveTagTree(testTree, {
  table: testTagsTable,
  carriers: [singleTagCarrier(items, items.tagId)],
  editableExtras: ["note"],
  refuseDelete: (t) => (t.note === "locked" ? `${t.name} is locked` : null),
});

let t: TestDb;
let database: TagTreeDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "tag_tree" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    CREATE TABLE tag_tree_test_tags (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      parent_id text,
      color text,
      child_colors text,
      icon text,
      rank rank_text NOT NULL,
      note text DEFAULT '' NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )`);
  await t.db.execute(
    sql`CREATE TABLE tag_tree_test_items (id text PRIMARY KEY, tag_id text)`,
  );
  database = t.db as unknown as TagTreeDb;
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.delete(items);
  await t.db.delete(testTagsTable);
});

// ── Helpers ─────────────────────────────────────────────────────────────

interface StoredTag {
  id: string;
  name: string;
  parentId: string | null;
  rank: string;
  note: string;
}

async function all(): Promise<StoredTag[]> {
  return (await t.db
    .select()
    .from(testTagsTable)
    .orderBy(asc(testTagsTable.rank))) as StoredTag[];
}

/** The names of `parentId`'s children, in rank order. */
async function childNames(parentId: string | null): Promise<string[]> {
  return (await all())
    .filter((r) => r.parentId === parentId)
    .map((r) => r.name);
}

async function idOf(name: string): Promise<string> {
  const row = (await all()).find((r) => r.name === name);
  if (!row) throw new Error(`no tag named ${name}`);
  return row.id;
}

async function create(name: string, parentId: string | null = null) {
  return (await createTagIn(served, database, { name, parentId })).id;
}

async function expectHttp(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
}

// ── Create ──────────────────────────────────────────────────────────────

describe("create", () => {
  test("appends each new tag last among its siblings", async () => {
    const app = await create("app");
    await create("infra");
    await create("website", app);
    await create("chord", app);
    expect(await childNames(null)).toEqual(["app", "infra"]);
    expect(await childNames(app)).toEqual(["website", "chord"]);
    expect(testTagIdKind.is(app)).toBe(true);
  });

  test("a sibling's name (case-insensitive) is a 400; a cousin's is fine", async () => {
    const app = await create("app");
    const infra = await create("infra");
    await create("website", app);
    await expectHttp(create("WebSite", app), 400);
    await create("website", infra);
    expect(await childNames(infra)).toEqual(["website"]);
  });

  test("an unknown parent is a 404", async () => {
    await expectHttp(create("x", "tttag-nope"), 404);
  });

  test("extra: an editable field is stored; any other key is a 400", async () => {
    const { id } = await createTagIn(served, database, {
      name: "noted",
      extra: { note: "hello" },
    });
    expect((await all()).find((r) => r.id === id)?.note).toBe("hello");
    await expectHttp(
      createTagIn(served, database, { name: "bad", extra: { rank: "a0" } }),
      400,
    );
  });
});

// ── Create path ─────────────────────────────────────────────────────────

describe("createPath", () => {
  test("creates every missing segment under the previous and answers the leaf", async () => {
    const made = await createTagPathIn(served, database, {
      segments: ["app", "website", "homepage"],
    });
    expect(made.created).toHaveLength(3);
    expect(made.id).toBe(made.created[2]!);
    expect(await childNames(made.created[1]!)).toEqual(["homepage"]);
  });

  test("reuses existing segments case-insensitively", async () => {
    const first = await createTagPathIn(served, database, {
      segments: ["App", "Website"],
    });
    const again = await createTagPathIn(served, database, {
      segments: ["app", "WEBSITE"],
    });
    expect(again).toEqual({ id: first.id, created: [] });
    const deeper = await createTagPathIn(served, database, {
      segments: ["APP", "chord"],
    });
    expect(deeper.created).toEqual([deeper.id]);
    expect(await childNames(first.created[0]!)).toEqual(["Website", "chord"]);
    expect(await all()).toHaveLength(3);
  });
});

// ── Update ──────────────────────────────────────────────────────────────

describe("update", () => {
  test("renames, recolours; a sibling's name is a 400", async () => {
    const a = await create("a");
    await create("b");
    await updateTagIn(served, database, a, { name: "alpha", color: "#112233" });
    const row = (await all()).find((r) => r.id === a);
    expect(row?.name).toBe("alpha");
    await expectHttp(updateTagIn(served, database, a, { name: "B" }), 400);
    await expectHttp(
      updateTagIn(served, database, "tttag-nope", { name: "x" }),
      404,
    );
  });
});

// ── Move ────────────────────────────────────────────────────────────────

describe("move", () => {
  test("before / after a sibling, and inside a tag (appended)", async () => {
    const a = await create("a");
    const b = await create("b");
    const c = await create("c");
    await moveTagIn(served, database, c, {
      parentId: null,
      targetId: a,
      zone: "before",
    });
    expect(await childNames(null)).toEqual(["c", "a", "b"]);
    await moveTagIn(served, database, c, {
      parentId: null,
      targetId: a,
      zone: "after",
    });
    expect(await childNames(null)).toEqual(["a", "c", "b"]);
    const d = await create("d", b);
    await moveTagIn(served, database, a, {
      parentId: b,
      targetId: null,
      zone: "after",
    });
    expect(await childNames(b)).toEqual(["d", "a"]);
    expect(await childNames(null)).toEqual(["c", "b"]);
    // "Move out of b": after b, under b's parent.
    await moveTagIn(served, database, d, {
      parentId: null,
      targetId: b,
      zone: "after",
    });
    expect(await childNames(null)).toEqual(["c", "b", "d"]);
  });

  test("under itself or a descendant is a 400", async () => {
    const a = await create("a");
    const b = await create("b", a);
    await expectHttp(
      moveTagIn(served, database, a, {
        parentId: b,
        targetId: null,
        zone: "after",
      }),
      400,
    );
    await expectHttp(
      moveTagIn(served, database, a, {
        parentId: a,
        targetId: null,
        zone: "after",
      }),
      400,
    );
  });

  test("a target that is not a child of the destination is a 400", async () => {
    const a = await create("a");
    const b = await create("b", a);
    const c = await create("c");
    await expectHttp(
      moveTagIn(served, database, c, {
        parentId: null,
        targetId: b,
        zone: "before",
      }),
      400,
    );
  });
});

// ── Delete ──────────────────────────────────────────────────────────────

describe("delete", () => {
  test("lifts the children to the parent at the tag's position, in order, and rewrites carriers", async () => {
    const root = await create("root");
    await create("first", root);
    const mid = await create("mid", root);
    await create("last", root);
    const x = await create("x", mid);
    const y = await create("y", mid);
    await t.db.insert(items).values([
      { id: "i1", tagId: mid },
      { id: "i2", tagId: x },
      { id: "i3", tagId: root },
    ]);
    await deleteTagIn(served, database, mid);
    expect(await childNames(root)).toEqual(["first", "x", "y", "last"]);
    expect((await all()).some((r) => r.id === mid)).toBe(false);
    const carried = await t.db.select().from(items).orderBy(asc(items.id));
    expect(carried).toEqual([
      { id: "i1", tagId: root },
      { id: "i2", tagId: x },
      { id: "i3", tagId: root },
    ]);
    expect(y).toBeTruthy();
  });

  test("a root tag's carriers end with no tag", async () => {
    const solo = await create("solo");
    await t.db.insert(items).values({ id: "i1", tagId: solo });
    await deleteTagIn(served, database, solo);
    expect(await t.db.select().from(items)).toEqual([
      { id: "i1", tagId: null },
    ]);
  });

  test("refuseDelete is a 400 and deletes nothing", async () => {
    const { id } = await createTagIn(served, database, {
      name: "keep",
      extra: { note: "locked" },
    });
    await expectHttp(deleteTagIn(served, database, id), 400);
    expect(await idOf("keep")).toBe(id);
    await expectHttp(deleteTagIn(served, database, "tttag-nope"), 404);
  });
});

// ── Registry ────────────────────────────────────────────────────────────

describe("resolveServedTree", () => {
  test("an unknown tree is a 404; two trees of one id throw", () => {
    expect(resolveServedTree("test-tree", [served])).toBe(served);
    let err: unknown;
    try {
      resolveServedTree("nope", [served]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(() => resolveServedTree("test-tree", [served, served])).toThrow(
      /2 trees are registered as "test-tree"/,
    );
  });
});
