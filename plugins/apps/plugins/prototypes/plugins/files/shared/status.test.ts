import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATUS_DIR_NAME, openStatusStore, type StatusStore } from "./status";

// The status store against a throwaway prototypes tree. The file layout, lock
// and atomic write are the shared record store's, pinned by `picks.test.ts`;
// this pins what is particular to a status, and `readAll`.

const ID = "proto-1789000000-abcd";
const OTHER = "proto-1789000001-wxyz";

let root: string;
let store: StatusStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prototype-status-"));
  store = openStatusStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("openStatusStore", () => {
  test("no file is not done, and readAll is empty", async () => {
    expect(await store.read(ID)).toEqual({
      done: false,
      pinned: false,
      deletedAt: null,
    });
    expect(await store.readAll()).toEqual({});
  });

  test("marking done writes the file under _status/; unmarking removes it", async () => {
    expect(await store.write(ID, { done: true })).toEqual({
      done: true,
      pinned: false,
      deletedAt: null,
    });
    expect(store.fileOf(ID)).toBe(join(root, STATUS_DIR_NAME, `${ID}.json`));
    expect(existsSync(store.fileOf(ID))).toBe(true);

    expect(await store.write(ID, { done: false })).toEqual({
      done: false,
      pinned: false,
      deletedAt: null,
    });
    expect(existsSync(store.fileOf(ID))).toBe(false);
  });

  test("a pin and Done are set independently; a change never clobbers the other", async () => {
    await store.write(ID, { pinned: true });
    expect(await store.write(ID, { done: true })).toEqual({
      done: true,
      pinned: true,
      deletedAt: null,
    });
    expect(await store.write(ID, { pinned: false })).toEqual({
      done: true,
      pinned: false,
      deletedAt: null,
    });
  });

  test("a file written before pins existed reads as not pinned", async () => {
    await mkdir(join(root, STATUS_DIR_NAME), { recursive: true });
    await writeFile(store.fileOf(ID), '{"done": true}');
    expect(await store.read(ID)).toEqual({
      done: true,
      pinned: false,
      deletedAt: null,
    });
  });

  test("a delete is a field of its own; a restore clears it and the file goes", async () => {
    const at = "2026-10-24T10:00:00.000Z";
    await store.write(ID, { pinned: true });
    expect(await store.write(ID, { deletedAt: at })).toEqual({
      done: false,
      pinned: true,
      deletedAt: at,
    });
    // Deleting again keeps the first instant.
    expect(
      (await store.write(ID, { deletedAt: "2026-10-25T10:00:00.000Z" }))
        .deletedAt,
    ).toBe(at);
    await store.write(ID, { pinned: false });
    expect(await store.write(ID, { deletedAt: null })).toEqual({
      done: false,
      pinned: false,
      deletedAt: null,
    });
    expect(existsSync(store.fileOf(ID))).toBe(false);
  });

  test("readAll keys every recorded status by id, skipping foreign files", async () => {
    await store.write(ID, { done: true });
    await store.write(OTHER, { done: true });
    await writeFile(join(root, STATUS_DIR_NAME, "notes.json"), "{}");
    expect(await store.readAll()).toEqual({
      [ID]: { done: true, pinned: false, deletedAt: null },
      [OTHER]: { done: true, pinned: false, deletedAt: null },
    });
  });

  test("a malformed file throws from readAll — never read as not done", async () => {
    await mkdir(join(root, STATUS_DIR_NAME), { recursive: true });
    await writeFile(store.fileOf(ID), '{"done": "yes"}');
    let message = "";
    try {
      await store.readAll();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("malformed prototype status file");
  });
});
