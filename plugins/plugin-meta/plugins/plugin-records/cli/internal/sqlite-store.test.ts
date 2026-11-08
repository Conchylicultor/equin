import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordKey } from "../../core";
import { openRecordStore } from "./sqlite-store";
import { describeVerification, verifyRecordsAgainst } from "./verifying-store";

const dir = mkdtempSync(join(tmpdir(), "plugin-records-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const k = (name: string): string => recordKey(name);

test("records survive a reopen, per table, and a present key keeps its value", () => {
  const path = join(dir, "records.sqlite");
  const a = openRecordStore({ path });
  a.putMany("facet", [
    [k("1"), "v1"],
    [k("2"), "v2"],
  ]);
  a.putMany("facet", [[k("1"), "other"]]);
  a.flush();
  const b = openRecordStore({ path });
  expect([...b.getMany("facet", [k("1"), k("2"), k("3")])]).toEqual([
    [k("1"), "v1"],
    [k("2"), "v2"],
  ]);
  expect(b.getMany("file", [k("1")]).size).toBe(0);
});

test("puts are held until a flush: own reads see them, another process's do not", () => {
  const path = join(dir, "held.sqlite");
  const a = openRecordStore({ path });
  const b = openRecordStore({ path });
  a.putMany("facet", [[k("h"), "held"]]);
  expect(a.getMany("facet", [k("h")]).get(k("h"))).toBe("held");
  expect(b.getMany("facet", [k("h")]).size).toBe(0);
  a.flush();
  expect(b.getMany("facet", [k("h")]).get(k("h"))).toBe("held");
  // A key held twice keeps its first value, as a stored one does.
  a.putMany("facet", [[k("h2"), "first"]]);
  a.putMany("facet", [[k("h2"), "second"]]);
  a.flush();
  expect(b.getMany("facet", [k("h2")]).get(k("h2"))).toBe("first");
});

test("a batch larger than one statement's parameters is read whole", () => {
  const s = openRecordStore({ path: join(dir, "big.sqlite") });
  const entries = Array.from(
    { length: 1234 },
    (_, i) => [k(`${i}`), `v${i}`] as const,
  );
  s.putMany("module", entries);
  expect(
    s.getMany(
      "module",
      entries.map(([key]) => key),
    ).size,
  ).toBe(1234);
});

test("one value stored under many keys is stored once", () => {
  const path = join(dir, "dedupe.sqlite");
  const s = openRecordStore({ path });
  const value = "x".repeat(10_000);
  s.putMany(
    "evaluated",
    Array.from({ length: 50 }, (_, i) => [k(`e${i}`), value] as const),
  );
  s.putMany("facet", [[k("f"), value]]);
  expect(s.getMany("facet", [k("f")]).get(k("f"))).toBe(value);
  s.flush();
  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM vals").get()).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) AS n FROM keys").get()).toEqual({ n: 51 });
  db.close();
});

test("the daily reclaim drops unread keys, then the values nobody names", () => {
  const path = join(dir, "reclaim.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [
    [k("old"), "only-old"],
    [k("shared-old"), "shared"],
    [k("new"), "shared"],
  ]);
  s.flush();
  const db = new Database(path);
  db.query("UPDATE keys SET used = used - 30 WHERE key != ?").run(
    Buffer.from(k("new"), "hex"),
  );
  db.query("DELETE FROM meta").run();
  db.close();
  const again = openRecordStore({ path });
  expect([
    ...again.getMany("file", [k("old"), k("shared-old"), k("new")]),
  ]).toEqual([[k("new"), "shared"]]);
  const check = new Database(path, { readonly: true });
  expect(check.query("SELECT value FROM vals").all()).toEqual([
    { value: "shared" },
  ]);
  check.close();
});

test("opening an existing store never waits for a writer", () => {
  const path = join(dir, "open-under-writer.sqlite");
  const seed = openRecordStore({ path });
  seed.putMany("file", [[k("w"), "v"]]);
  seed.flush();
  // Another process mid-transaction holds the write lock; an open (and a
  // read) goes ahead at once — with no busy wait to hide behind.
  const writer = new Database(path);
  writer.exec("BEGIN IMMEDIATE");
  writer.exec("UPDATE keys SET used = used");
  const t0 = performance.now();
  const s = openRecordStore({ path });
  expect(s.getMany("file", [k("w")]).get(k("w"))).toBe("v");
  expect(performance.now() - t0).toBeLessThan(5_000);
  writer.exec("ROLLBACK");
  writer.close();
  // The fresh file still got the setting only a creation can give it.
  const check = new Database(path, { readonly: true });
  expect(check.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
  check.close();
});

test("a key that is not a record key is refused", () => {
  const s = openRecordStore({ path: join(dir, "refuse.sqlite") });
  expect(() => s.putMany("file", [["k1", "v"]])).toThrow(/not a record key/);
});

test("the verifier recomputes everything and names a record whose value moved under its key", () => {
  const shared = openRecordStore({ path: join(dir, "verify.sqlite") });
  shared.putMany("facet", [
    [k("same"), "a"],
    [k("moved"), "stored"],
  ]);
  const v = verifyRecordsAgainst(shared);
  // Reads see only what this process computed: every record is made again.
  expect(v.store.getMany("facet", [k("same"), k("moved")]).size).toBe(0);
  v.store.putMany("facet", [
    [k("same"), "a"],
    [k("moved"), "fresh"],
    [k("new"), "n"],
  ]);
  // Made twice in one process: compared once.
  v.store.putMany("facet", [[k("moved"), "fresh"]]);
  expect(v.store.getMany("facet", [k("same")]).get(k("same"))).toBe("a");
  expect(v.agreed).toBe(1);
  expect(v.absent).toBe(1);
  expect(v.disagreements).toEqual([
    { table: "facet", key: k("moved"), stored: "stored", fresh: "fresh" },
  ]);
  expect(describeVerification(v)[0]).toContain("1 disagree");
  // The shared store is never written.
  expect(shared.getMany("facet", [k("new")]).size).toBe(0);
});
