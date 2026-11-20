import { afterEach, describe, expect, it } from "bun:test";
import { deleteStorageDatabases } from "./wipe";

const g = globalThis as { indexedDB?: unknown };

afterEach(() => {
  delete g.indexedDB;
});

/** A request whose success fires on the next microtask. */
function succeed<T>(result: T): IDBRequest<T> {
  const req = { result } as unknown as IDBRequest<T>;
  queueMicrotask(() => req.onsuccess?.(new Event("success")));
  return req;
}

function fakeIdb(listed: string[] | null): string[] {
  const deleted: string[] = [];
  g.indexedDB = {
    ...(listed === null
      ? {}
      : { databases: () => Promise.resolve(listed.map((name) => ({ name }))) }),
    deleteDatabase: (name: string) => {
      deleted.push(name);
      return succeed(undefined);
    },
  };
  return deleted;
}

describe("deleteStorageDatabases", () => {
  it("deletes every database of the storage, the stores last, and nothing else", async () => {
    const deleted = fakeIdb([
      "equin-host--demo--stores",
      "/pglite/equin-host--demo--db",
      "equin-host--other--stores",
    ]);
    await deleteStorageDatabases("demo");
    expect(deleted).toEqual([
      "/pglite/equin-host--demo--db",
      "equin-host--demo--stores",
    ]);
  });

  it("deletes the names the storage has where the browser lists no databases", async () => {
    const deleted = fakeIdb(null);
    await deleteStorageDatabases("demo");
    expect(deleted).toEqual([
      "/pglite/equin-host--demo--db",
      "equin-host--demo--stores",
    ]);
  });
});
