/**
 * Real-DB suite for the trash primitive's ledger + restore/purge lifecycle.
 * Headless: drives the db-parametrized `recordTrashEntry`/`consumeTrashEntry`
 * against a throwaway Postgres (db-test-fixture) with fake registered sources.
 *
 * Run: `bun test plugins/infra/plugins/trash`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import type { TrashEntry } from "../../core/schemas";
import { consumeTrashEntry } from "./entry-lifecycle";
import { defineTrashSource } from "./registry";
import { recordTrashEntry } from "./record-entry";
import { _trashEntries } from "./tables";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "trash_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see the
 * host-semaphore suite's identical helper), so this asserts the rejection for
 * real and hands back the error to pin its message/class.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("recordTrashEntry", () => {
  test("inserts one ledger row and returns its id", async () => {
    const entryId = await recordTrashEntry(t.db, {
      sourceId: "test-record",
      rootEntityId: "root-1",
      label: "My page",
    });

    const [row] = await t.db
      .select()
      .from(_trashEntries)
      .where(eq(_trashEntries.id, entryId));
    expect(row).toBeDefined();
    expect(row?.sourceId).toBe("test-record");
    expect(row?.rootEntityId).toBe("root-1");
    expect(row?.label).toBe("My page");
    expect(row?.meta).toEqual({});
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});

describe("consumeTrashEntry", () => {
  test("restore path: action sees the entry, then the ledger row is deleted", async () => {
    const restored: TrashEntry[] = [];
    await defineTrashSource({
      id: "test-restore",
      restore: async (entry) => {
        restored.push(entry);
      },
      purge: async () => {
        throw new Error("unexpected purge");
      },
    }).register();

    const entryId = await recordTrashEntry(t.db, {
      sourceId: "test-restore",
      rootEntityId: "root-2",
      label: "Restorable",
      meta: { hint: "kept" },
    });

    const result = await consumeTrashEntry(
      t.db,
      { sourceId: "test-restore", entryId },
      (source, entry) => source.restore(entry),
    );
    expect(result).toEqual({ ok: true });
    expect(restored).toHaveLength(1);
    expect(restored[0]?.rootEntityId).toBe("root-2");
    expect(restored[0]?.meta).toEqual({ hint: "kept" });

    const remaining = await t.db
      .select()
      .from(_trashEntries)
      .where(eq(_trashEntries.id, entryId));
    expect(remaining).toHaveLength(0);
  });

  test("double consume is a typed 404, never a silent no-op", async () => {
    await defineTrashSource({
      id: "test-double",
      restore: async () => {},
      purge: async () => {},
    }).register();

    const entryId = await recordTrashEntry(t.db, {
      sourceId: "test-double",
      rootEntityId: "root-3",
      label: "Once",
    });

    await consumeTrashEntry(
      t.db,
      { sourceId: "test-double", entryId },
      (s, e) => s.restore(e),
    );

    const err = await rejection(
      consumeTrashEntry(t.db, { sourceId: "test-double", entryId }, (s, e) =>
        s.restore(e),
      ),
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
  });

  test("a failing action leaves the entry row in place (retryable)", async () => {
    await defineTrashSource({
      id: "test-fail",
      restore: async () => {
        throw new Error("restore boom");
      },
      purge: async () => {},
    }).register();

    const entryId = await recordTrashEntry(t.db, {
      sourceId: "test-fail",
      rootEntityId: "root-4",
      label: "Sticky",
    });

    const err = await rejection(
      consumeTrashEntry(t.db, { sourceId: "test-fail", entryId }, (s, e) =>
        s.restore(e),
      ),
    );
    expect(err.message).toBe("restore boom");

    const remaining = await t.db
      .select()
      .from(_trashEntries)
      .where(eq(_trashEntries.id, entryId));
    expect(remaining).toHaveLength(1);
  });

  test("unregistered source is a loud config error, not a 404", async () => {
    const err = await rejection(
      consumeTrashEntry(
        t.db,
        { sourceId: "never-registered", entryId: "whatever" },
        (s, e) => s.restore(e),
      ),
    );
    expect(err).not.toBeInstanceOf(HttpError);
    expect(err.message).toMatch(/no trash source registered/);
  });
});

describe("defineTrashSource", () => {
  test("duplicate source id throws at register()", async () => {
    const make = () =>
      defineTrashSource({
        id: "test-dup",
        restore: async () => {},
        purge: async () => {},
      });
    await make().register();
    // `register()` throws synchronously on the duplicate-id Map check; `void`
    // marks the (never-produced) promise as intentionally unawaited.
    expect(() => void make().register()).toThrow(/duplicate trash source/);
  });
});
