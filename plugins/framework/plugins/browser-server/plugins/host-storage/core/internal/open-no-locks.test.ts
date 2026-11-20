/**
 * A persistent storage opened where the worker has no Web Locks (iOS Lockdown
 * Mode, some webviews — report-1795088221-b1uksj): nothing can own the stored
 * data, so it serves from memory, filled from its snapshot, and never touches
 * IndexedDB (Bun has neither Web Locks nor IndexedDB: a touch would throw).
 */

import { describe, expect, test } from "bun:test";
import { webLocks } from "@plugins/primitives/plugins/dom/plugins/web-locks/core";
import { encodeHostSnapshot } from "./snapshot";
import { openHostStorage } from "./open";

const TAKEN_AT = 1_790_000_000_000;

async function snapshotRef() {
  const file = await encodeHostSnapshot({
    takenAt: TAKEN_AT,
    migrations: ["m1"],
    database: new Blob([new Uint8Array([1, 2, 3])]),
    stores: { notes: [["a", { at: TAKEN_AT }]] },
  });
  return {
    version: "v1",
    takenAt: TAKEN_AT,
    load: () => Promise.resolve(file),
  };
}

const spec = (start?: Awaited<ReturnType<typeof snapshotRef>>) => ({
  kind: "persistent" as const,
  name: "demo-workspace",
  migrations: ["m1"],
  start:
    start === undefined
      ? undefined
      : { snapshot: start, whenOutdated: "reset" as const },
  identity: { build: "b1", worker: "demo@1" },
  onSuperseded: () => Promise.resolve(),
});

describe("openHostStorage without Web Locks", () => {
  test("Bun has no Web Locks — what the visitor's Safari worker had", () => {
    expect(webLocks().kind).toBe("unsupported");
  });

  test("serves the snapshot from memory, its times shifted to now", async () => {
    const before = Date.now();
    const storage = await openHostStorage(spec(await snapshotRef()));
    expect(storage.kind).toBe("memory");
    expect(storage.databaseDir).toBeUndefined();
    expect(storage.origin).toEqual({
      kind: "snapshot",
      replacedOutdated: false,
    });
    const start = storage.databaseStart;
    if (start.from !== "snapshot") throw new Error(`got ${start.from}`);
    expect([...new Uint8Array(await start.dataDir.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    expect(start.shiftMs).toBeGreaterThanOrEqual(before - TAKEN_AT);

    const notes = storage.store<{ at: number }>("notes", {
      shiftTime: (v, ms) => ({ at: v.at + ms }),
    });
    expect(notes.loaded.get("a")!.at).toBe(TAKEN_AT + start.shiftMs);
    // Writes are checked, kept nowhere.
    notes.put("b", { at: 1 });
    expect(() =>
      storage
        .store<unknown>("blobs", { shiftTime: (v) => v })
        .put("x", new Blob([])),
    ).toThrow(/Blob/);

    await storage.booted();
    await storage.wipe();
  });

  test("starts empty without a snapshot", async () => {
    const storage = await openHostStorage(spec());
    expect(storage.kind).toBe("memory");
    expect(storage.origin).toEqual({ kind: "empty" });
    expect(storage.databaseStart).toEqual({ from: "stored-or-empty" });
  });

  test("closes what it adopted", async () => {
    const storage = await openHostStorage(spec());
    let closed = 0;
    storage.adopt({
      flush: () => Promise.resolve(),
      close: () => {
        closed++;
        return Promise.resolve();
      },
      dump: () => Promise.resolve(new Blob([])),
    });
    await storage.close();
    expect(closed).toBe(1);
  });
});
