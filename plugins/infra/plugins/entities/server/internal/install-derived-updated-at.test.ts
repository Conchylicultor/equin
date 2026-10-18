/**
 * Real-DB suite for the derived-`updatedAt` trigger: installs a stand-in
 * entity's compiled trigger into a throwaway database (db-test-fixture) and
 * drives it with real UPDATEs, because the whole guarantee is the generated
 * plpgsql — asserting on strings would prove nothing about what Postgres does.
 *
 * Lives in entities (not database/derived-updated-at) because it drives the
 * whole path: `defineEntity`'s declaration → physical column names → compiled
 * trigger → install, plus the raw-`pgTable` path (`deriveUpdatedAt`). It
 * installs exactly its own tables' specs (`installDerivedUpdatedAt(db,
 * [spec])`): the registry is process-wide and also holds every other suite's
 * entities, whose tables this database does not have.
 *
 * Requires the running embedded cluster (`./singularity build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { defineFieldType } from "@plugins/fields/core";
import type { FieldDef } from "@plugins/fields/core";
import { Fields } from "@plugins/fields/plugins/server-capabilities/server";
import { entityRef } from "../../core";
import { defineEntity } from "./define-entity";
import {
  compileFromTable,
  deriveUpdatedAt,
  installDerivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import { defaultNow } from "./types";

const textType = defineFieldType<string>("__dua_db_text__");
const dateType = defineFieldType<Date>("__dua_db_date__");

collectContributions([
  {
    id: "install-derived-updated-at-test",
    contributions: [
      Fields.Storage({ type: textType, build: (n) => text(n) }),
      Fields.Storage({
        type: dateType,
        build: (n) => timestamp(n, { withTimezone: true }),
      }),
    ],
  },
]);

function field<T>(
  type: ReturnType<typeof defineFieldType<T>>,
  schema: z.ZodType<T>,
  defaultValue: T,
): FieldDef<T> {
  return Object.freeze({ type, schema, defaultValue, meta: {} });
}

type Status = "waiting" | "starting" | "working" | "done";
const statusField = field(
  textType as unknown as ReturnType<typeof defineFieldType<Status>>,
  z.enum([
    "waiting",
    "starting",
    "working",
    "done",
  ]) as unknown as z.ZodType<Status>,
  "waiting",
);

// The conversations shape in miniature: an edited column, a status whose
// turn start / turn end / close count but whose resume bounce does not, and a
// viewed-at that never counts.
const items = defineEntity(
  entityRef("dua_items", {
    id: field(textType, z.string(), ""),
    title: field(textType, z.string(), ""),
    status: statusField,
    lastViewedAt: field(dateType, z.coerce.date(), new Date(0)),
    updatedAt: field(dateType, z.coerce.date(), new Date(0)),
  }),
  {
    primaryKey: "id",
    columns: { updatedAt: { default: defaultNow() } },
    updatedAt: {
      touchedBy: {
        id: false,
        title: true,
        status: { into: ["working", "done"], outOf: ["working"] },
        lastViewedAt: false,
      },
    },
  },
);
const spec = items.derivedUpdatedAt;
if (!spec) throw new Error("dua_items: expected a derived updatedAt spec");

// A raw drizzle table (no defineEntity) declared through deriveUpdatedAt: the
// path the hand-written `pgTable`s take.
const rawNotes = deriveUpdatedAt(
  pgTable("dua_raw_notes", {
    id: text("id").primaryKey(),
    body: jsonb("body").$type<{ text: string; icon?: string }>().notNull(),
    expanded: text("expanded_state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  }),
  { touchedBy: { id: false, body: { exceptKeys: ["icon"] }, expanded: false } },
);
const rawSpec = compileFromTable(rawNotes, {
  id: false,
  body: { exceptKeys: ["icon"] },
  expanded: false,
});

const OLD = "2000-01-01T00:00:00.000Z";
let t: TestDb;
let seq = 0;

async function insertItem(status: Status = "waiting"): Promise<string> {
  const id = `i${++seq}`;
  await t.db.execute(
    sql`INSERT INTO dua_items (id, title, status, last_viewed_at, updated_at)
        VALUES (${id}, 'a', ${status}, ${OLD}, ${OLD})`,
  );
  return id;
}

async function bumped(id: string): Promise<boolean> {
  const res = await t.db.execute(
    sql`SELECT updated_at <> ${OLD}::timestamptz AS bumped FROM dua_items WHERE id = ${id}`,
  );
  return (res.rows[0] as { bumped: boolean }).bumped;
}

async function setStatus(id: string, status: Status): Promise<void> {
  await t.db.execute(
    sql`UPDATE dua_items SET status = ${status} WHERE id = ${id}`,
  );
}

// `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it
// asserts nothing; this awaits the rejection for real.
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "derived_updated_at_test" });
  await t.db.execute(sql`
    CREATE TABLE dua_items (
      id             text PRIMARY KEY,
      title          text NOT NULL,
      status         text NOT NULL,
      last_viewed_at timestamptz NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `);
  await t.db.execute(sql`
    CREATE TABLE dua_raw_notes (
      id             text PRIMARY KEY,
      body           jsonb NOT NULL,
      expanded_state text NOT NULL,
      updated_at     timestamptz NOT NULL DEFAULT now()
    )
  `);
  await installDerivedUpdatedAt(t.db, [rawSpec]);
});

afterAll(async () => {
  await t.drop();
});

describe("installDerivedUpdatedAt", () => {
  test("installs once, then is a catalog-only no-op", async () => {
    expect(await installDerivedUpdatedAt(t.db, [spec])).toEqual([
      { table: "dua_items", outcome: "installed" },
    ]);
    expect(await installDerivedUpdatedAt(t.db, [spec])).toEqual([
      { table: "dua_items", outcome: "unchanged" },
    ]);
  });

  test("reinstalls a trigger dropped out of band", async () => {
    await t.db.execute(
      sql`DROP TRIGGER "dua_items_derive_updated_at" ON dua_items`,
    );
    expect(await installDerivedUpdatedAt(t.db, [spec])).toEqual([
      { table: "dua_items", outcome: "installed" },
    ]);
  });

  test("throws when the table does not exist", async () => {
    const err = await rejection(
      installDerivedUpdatedAt(t.db, [{ ...spec, table: "dua_missing" }]),
    );
    expect(err.message).toMatch(/does not exist/);
  });
});

describe("the derived updated_at trigger", () => {
  test("a counted column changing bumps", async () => {
    const id = await insertItem();
    await t.db.execute(sql`UPDATE dua_items SET title = 'b' WHERE id = ${id}`);
    expect(await bumped(id)).toBe(true);
  });

  test("writing the same value does not bump", async () => {
    const id = await insertItem();
    await t.db.execute(
      sql`UPDATE dua_items SET title = 'a', status = 'waiting' WHERE id = ${id}`,
    );
    expect(await bumped(id)).toBe(false);
  });

  test("an uncounted column does not bump (drizzle write, physical names)", async () => {
    const id = await insertItem();
    await t.db
      .update(items.table)
      .set({ lastViewedAt: new Date() })
      .where(eq(items.table.id, id));
    expect(await bumped(id)).toBe(false);
  });

  test("into / outOf transitions bump", async () => {
    const turnStart = await insertItem("waiting");
    await setStatus(turnStart, "working");
    expect(await bumped(turnStart)).toBe(true);

    const turnEnd = await insertItem("working");
    await setStatus(turnEnd, "waiting");
    expect(await bumped(turnEnd)).toBe(true);

    const close = await insertItem("waiting");
    await setStatus(close, "done");
    expect(await bumped(close)).toBe(true);
  });

  test("other transitions do not bump", async () => {
    const id = await insertItem("waiting");
    await setStatus(id, "starting");
    await setStatus(id, "waiting");
    expect(await bumped(id)).toBe(false);
  });

  test("writing updated_at raises; rewriting its own value passes", async () => {
    const id = await insertItem();
    const err = await rejection(
      t.db.execute(
        sql`UPDATE dua_items SET updated_at = now() WHERE id = ${id}`,
      ),
    );
    expect(err.message).toMatch(/dua_items.updated_at is derived/);
    await t.db.execute(
      sql`UPDATE dua_items SET updated_at = updated_at WHERE id = ${id}`,
    );
    expect(await bumped(id)).toBe(false);
  });
});

describe("a raw pgTable declared through deriveUpdatedAt", () => {
  async function insertNote(): Promise<string> {
    const id = `n${++seq}`;
    await t.db.insert(rawNotes).values({
      id,
      body: { text: "a" },
      expanded: "open",
      updatedAt: new Date(OLD),
    });
    return id;
  }

  async function noteBumped(id: string): Promise<boolean> {
    const [row] = await t.db
      .select({ updatedAt: rawNotes.updatedAt })
      .from(rawNotes)
      .where(eq(rawNotes.id, id));
    if (!row) throw new Error(`no note ${id}`);
    return row.updatedAt.getTime() !== new Date(OLD).getTime();
  }

  test("a counted change bumps", async () => {
    const id = await insertNote();
    await t.db
      .update(rawNotes)
      .set({ body: { text: "b" } })
      .where(eq(rawNotes.id, id));
    expect(await noteBumped(id)).toBe(true);
  });

  test("a no-op or an uncounted change does not bump", async () => {
    const id = await insertNote();
    await t.db
      .update(rawNotes)
      .set({ body: { text: "a" }, expanded: "closed" })
      .where(eq(rawNotes.id, id));
    expect(await noteBumped(id)).toBe(false);
  });

  test("an exceptKeys key alone does not bump; with another key it does", async () => {
    const id = await insertNote();
    await t.db
      .update(rawNotes)
      .set({ body: { text: "a", icon: "🧪" } })
      .where(eq(rawNotes.id, id));
    expect(await noteBumped(id)).toBe(false);
    await t.db
      .update(rawNotes)
      .set({ body: { text: "a" } })
      .where(eq(rawNotes.id, id));
    expect(await noteBumped(id)).toBe(false);
    await t.db
      .update(rawNotes)
      .set({ body: { text: "b", icon: "🎶" } })
      .where(eq(rawNotes.id, id));
    expect(await noteBumped(id)).toBe(true);
  });

  test("writing updated_at raises", async () => {
    const id = await insertNote();
    const err = await rejection(
      t.db
        .update(rawNotes)
        .set({ updatedAt: new Date() })
        .where(eq(rawNotes.id, id)),
    );
    expect(
      `${err.message} ${String((err as { cause?: unknown }).cause)}`,
    ).toMatch(/dua_raw_notes.updated_at is derived/);
  });
});
