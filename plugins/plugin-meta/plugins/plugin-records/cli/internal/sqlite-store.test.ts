import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createTicketLine } from "@plugins/packages/plugins/ticket-line/core";
import { emptyWriteTiming, recordKey } from "../../core";
import {
  HOLD_MS,
  openRecordStore,
  reclaimRecordStore,
  writeBounded,
} from "./sqlite-store";
import { describeVerification, verifyRecordsAgainst } from "./verifying-store";

const dir = mkdtempSync(join(tmpdir(), "plugin-records-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const k = (name: string): string => recordKey(name);

/**
 * Ages every key row but `keep` by 30 days, and each value to the newest day
 * of the keys naming it — the invariant every write keeps (a value's day is
 * at least that of each key naming it).
 */
function age(path: string, keep: string[] = []): void {
  const db = new Database(path);
  const kept = keep.map((key) => Buffer.from(key, "hex"));
  db.query(
    `UPDATE keys SET used = used - 30 WHERE key NOT IN (${kept.map(() => "?").join(",")})`,
  ).run(...kept);
  db.exec(
    "UPDATE vals SET used = (SELECT max(used) FROM keys WHERE keys.val = vals.id)",
  );
  db.close();
}

/** Every value's text, as the store holds it. */
function storedValues(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const rows = db.query("SELECT body FROM vals ORDER BY id").all() as {
    body: Uint8Array;
  }[];
  db.close();
  return rows.map((r) =>
    Buffer.from(Bun.zstdDecompressSync(r.body)).toString("utf8"),
  );
}

test("records survive a reopen, per table, and a present key keeps its value", async () => {
  const path = join(dir, "records.sqlite");
  const a = openRecordStore({ path });
  a.putMany("facet", [
    [k("1"), "v1"],
    [k("2"), "v2"],
  ]);
  a.putMany("facet", [[k("1"), "other"]]);
  await a.flush();
  const b = openRecordStore({ path });
  expect([...(await b.getMany("facet", [k("1"), k("2"), k("3")]))]).toEqual([
    [k("1"), "v1"],
    [k("2"), "v2"],
  ]);
  expect((await b.getMany("file", [k("1")])).size).toBe(0);
});

test("puts are held until a flush: own reads see them, another process's do not", async () => {
  const path = join(dir, "held.sqlite");
  const a = openRecordStore({ path });
  const b = openRecordStore({ path });
  a.putMany("facet", [[k("h"), "held"]]);
  expect((await a.getMany("facet", [k("h")])).get(k("h"))).toBe("held");
  expect((await b.getMany("facet", [k("h")])).size).toBe(0);
  await a.flush();
  expect((await b.getMany("facet", [k("h")])).get(k("h"))).toBe("held");
  // A key held twice keeps its first value, as a stored one does.
  a.putMany("facet", [[k("h2"), "first"]]);
  a.putMany("facet", [[k("h2"), "second"]]);
  await a.flush();
  expect((await b.getMany("facet", [k("h2")])).get(k("h2"))).toBe("first");
});

test("a batch larger than one statement's parameters is read whole", async () => {
  const s = openRecordStore({ path: join(dir, "big.sqlite") });
  const entries = Array.from(
    { length: 1234 },
    (_, i) => [k(`${i}`), `v${i}`] as const,
  );
  s.putMany("module", entries);
  expect(
    (
      await s.getMany(
        "module",
        entries.map(([key]) => key),
      )
    ).size,
  ).toBe(1234);
});

test("one value stored under many keys is stored once", async () => {
  const path = join(dir, "dedupe.sqlite");
  const s = openRecordStore({ path });
  const value = "x".repeat(10_000);
  s.putMany(
    "evaluated",
    Array.from({ length: 50 }, (_, i) => [k(`e${i}`), value] as const),
  );
  s.putMany("facet", [[k("f"), value]]);
  expect((await s.getMany("facet", [k("f")])).get(k("f"))).toBe(value);
  await s.flush();
  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM vals").get()).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) AS n FROM keys").get()).toEqual({ n: 51 });
  db.close();
});

test("the reclaim drops unread keys, then the values only they named", async () => {
  const path = join(dir, "reclaim.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [
    [k("old"), "only-old"],
    [k("shared-old"), "shared"],
    [k("new"), "shared"],
  ]);
  s.putMany("facet", [[k("old-facet"), "only-old-facet"]]);
  await s.flush();
  age(path, [k("new")]);
  // An open reclaims nothing: that is the daily job's, off every open's path.
  openRecordStore({ path });
  const db = new Database(path, { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM keys").get()).toEqual({ n: 4 });
  db.close();
  expect(await reclaimRecordStore({ path })).toMatchObject({
    keysRead: 4,
    keysDeleted: 3,
    valuesDeleted: 2,
  });
  const again = openRecordStore({ path });
  expect([
    ...(await again.getMany("file", [k("old"), k("shared-old"), k("new")])),
  ]).toEqual([[k("new"), "shared"]]);
  expect((await again.getMany("facet", [k("old-facet")])).size).toBe(0);
  expect(storedValues(path)).toEqual(["shared"]);
  const check = new Database(path, { readonly: true });
  // Its marker, read by a checkout still on the code that reclaimed inside
  // an open.
  expect(check.query("SELECT name FROM meta").all()).toEqual([
    { name: "pruned" },
  ]);
  check.close();
});

test("a reclaim pages through more rows than one page holds", async () => {
  const path = join(dir, "reclaim-pages.sqlite");
  const s = openRecordStore({ path });
  s.putMany(
    "module",
    Array.from(
      { length: 12_345 },
      (_, i) => [k(`p${i}`), `v${i % 7}`] as const,
    ),
  );
  await s.flush();
  age(path);
  const r = await reclaimRecordStore({ path });
  expect(r).toMatchObject({
    keysRead: 12_345,
    keysDeleted: 12_345,
    valuesDeleted: 7,
    returnsPages: true,
  });
  expect(r.pagesFreed).toBeGreaterThan(0);
});

test("a reclaim of a file without incremental auto_vacuum ends, keeping its pages", async () => {
  const path = join(dir, "reclaim-none.sqlite");
  // A store whose file does not have the setting (one created before it
  // could take): VACUUM rewrites it without.
  openRecordStore({ path });
  const raw = new Database(path);
  raw.exec("PRAGMA auto_vacuum = NONE");
  raw.exec("VACUUM");
  expect(raw.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
  raw.close();
  const s = openRecordStore({ path });
  s.putMany(
    "file",
    Array.from({ length: 3_000 }, (_, i) => [k(`n${i}`), `v${i}`] as const),
  );
  await s.flush();
  age(path);
  expect(await reclaimRecordStore({ path })).toMatchObject({
    keysDeleted: 3_000,
    valuesDeleted: 3_000,
    returnsPages: false,
    pagesFreed: 0,
  });
});

test("a flush of several probe batches lands whole", async () => {
  const path = join(dir, "chunks.sqlite");
  const s = openRecordStore({ path });
  const entries = Array.from(
    { length: 4_321 },
    (_, i) => [k(`c${i}`), `v${i}`] as const,
  );
  s.putMany("file", entries);
  await s.flush();
  expect(
    (
      await openRecordStore({ path }).getMany(
        "file",
        entries.map(([key]) => key),
      )
    ).size,
  ).toBe(4_321);
});

test("opening an existing store never waits for a writer", async () => {
  const path = join(dir, "open-under-writer.sqlite");
  const seed = openRecordStore({ path });
  seed.putMany("file", [[k("w"), "v"]]);
  await seed.flush();
  // Another process mid-transaction holds the write lock; an open (and a
  // read) goes ahead at once — with no busy wait to hide behind.
  const writer = new Database(path);
  writer.exec("BEGIN IMMEDIATE");
  writer.exec("UPDATE keys SET used = used");
  const t0 = performance.now();
  const s = openRecordStore({ path });
  expect((await s.getMany("file", [k("w")])).get(k("w"))).toBe("v");
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

test("the verifier recomputes everything and names a record whose value moved under its key", async () => {
  const shared = openRecordStore({ path: join(dir, "verify.sqlite") });
  shared.putMany("facet", [
    [k("same"), "a"],
    [k("moved"), "stored"],
  ]);
  const v = verifyRecordsAgainst(shared);
  // Reads see only what this process computed: every record is made again.
  expect((await v.store.getMany("facet", [k("same"), k("moved")])).size).toBe(
    0,
  );
  v.store.putMany("facet", [
    [k("same"), "a"],
    [k("moved"), "fresh"],
    [k("new"), "n"],
  ]);
  // Made twice in one process: compared once.
  v.store.putMany("facet", [[k("moved"), "fresh"]]);
  expect((await v.store.getMany("facet", [k("same")])).get(k("same"))).toBe(
    "a",
  );
  await v.settled();
  expect(v.agreed).toBe(1);
  expect(v.absent).toBe(1);
  expect(v.disagreements).toEqual([
    { table: "facet", key: k("moved"), stored: "stored", fresh: "fresh" },
  ]);
  expect(describeVerification(v)[0]).toContain("1 disagree");
  // The shared store is never written.
  expect((await shared.getMany("facet", [k("new")])).size).toBe(0);
});

test("a bounded write commits once it has held the lock its budget, and every item lands", async () => {
  const path = join(dir, "bounded.sqlite");
  // The store's own schema, written directly.
  openRecordStore({ path });
  const db = new Database(path);
  // Another process's view: it sees an item once its transaction committed.
  const other = new Database(path, { readonly: true });
  const visible = (): number =>
    (other.query("SELECT count(*) AS n FROM keys").get() as { n: number }).n;
  const insert = db.query(
    "INSERT INTO keys (tbl, key, val, used) VALUES ('file', ?, 0, 0)",
  );
  // Each item costs ITEM_MS on the clock writeBounded reads: the rule is
  // tested, not how long the host takes to sleep.
  const ITEM_MS = 30;
  let clock = 0;
  const committedBefore: number[] = [];
  const probed: number[][] = [];
  const timing = emptyWriteTiming();
  await writeBounded(
    db,
    createTicketLine(asAppPath(`${path}.writers`)),
    Array.from({ length: 40 }, (_, i) => i),
    (batch) => {
      probed.push([...batch]);
      // Probed with no write lock held: another writer could take it.
      expect(db.inTransaction).toBe(false);
      return batch;
    },
    (i) => {
      committedBefore.push(visible());
      insert.run(Buffer.from(k(`b${i}`), "hex"));
      clock += ITEM_MS;
    },
    timing,
    { now: () => clock },
  );
  expect(visible()).toBe(40);
  // Items in one transaction all saw the same committed count.
  const sizes = new Map<number, number>();
  for (const n of committedBefore) sizes.set(n, (sizes.get(n) ?? 0) + 1);
  const perTransaction = [...sizes.values()];
  // Each transaction commits at the first item that brings its hold to
  // HOLD_MS — not before, not after — and the last takes what is left.
  const full = Math.ceil(HOLD_MS / ITEM_MS);
  expect(perTransaction).toEqual([
    ...Array.from({ length: Math.floor(40 / full) }, () => full),
    ...(40 % full > 0 ? [40 % full] : []),
  ]);
  // What one transaction left is probed again before the next.
  expect(probed[1]![0]).toBe(perTransaction[0]);
  // Each transaction's hold is measured on the same clock.
  expect(timing.transactions).toBe(perTransaction.length);
  expect(timing.heldMs).toBe(40 * ITEM_MS);
  other.close();
  db.close();
});

test("a flush writes nothing for a record another process stored meanwhile", async () => {
  const path = join(dir, "raced.sqlite");
  const a = openRecordStore({ path });
  const b = openRecordStore({ path });
  a.putMany("facet", [
    [k("both"), "same"],
    [k("only-a"), "a"],
  ]);
  b.putMany("facet", [[k("both"), "same"]]);
  await b.flush();
  const db = new Database(path);
  db.query("UPDATE keys SET used = 1 WHERE key = ?").run(
    Buffer.from(k("both"), "hex"),
  );
  db.close();
  await a.flush();
  const check = new Database(path, { readonly: true });
  // a's flush did not rewrite the row b stored (its day stays as set).
  expect(
    check
      .query("SELECT used FROM keys WHERE key = ?")
      .get(Buffer.from(k("both"), "hex")),
  ).toEqual({ used: 1 });
  check.close();
  expect(
    (await openRecordStore({ path }).getMany("facet", [k("both"), k("only-a")]))
      .size,
  ).toBe(2);
});

test("a writer waits its turn in the writer line, and its wait is measured", async () => {
  const path = join(dir, "line.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [[k("l"), "v"]]);
  // Another writer is at the head of the line.
  const ahead = await createTicketLine(asAppPath(`${path}.writers`)).join();
  let settled = false;
  const flushed = s.flush().then((outcome) => {
    settled = true;
    return outcome;
  });
  await Bun.sleep(300);
  // Queued behind it — not polling SQLite's lock, which nobody holds.
  expect(settled).toBe(false);
  // Its own reads still answer what it is writing.
  expect((await s.getMany("file", [k("l")])).get(k("l"))).toBe("v");
  await ahead.leave();
  const outcome = await flushed;
  expect(outcome).toMatchObject({ kind: "written", records: 1 });
  expect(outcome.timing.transactions).toBe(1);
  expect(outcome.timing.longestWaitMs).toBeGreaterThanOrEqual(250);
  expect(
    (await openRecordStore({ path }).getMany("file", [k("l")])).get(k("l")),
  ).toBe("v");
});

test("a write a lock outside the line keeps busy is lost, as an outcome — never a throw", async () => {
  const path = join(dir, "lost.sqlite");
  const s = openRecordStore({ path, busyTimeoutMs: 50 });
  s.putMany("file", [
    [k("x"), "1"],
    [k("y"), "2"],
  ]);
  // A writer outside the line (no ticket) holds SQLite's lock.
  const outside = new Database(path);
  outside.exec("BEGIN IMMEDIATE");
  const outcome = await s.flush();
  outside.exec("ROLLBACK");
  outside.close();
  expect(outcome).toMatchObject({ kind: "lost", records: 2, reason: "busy" });
  expect(outcome.kind === "lost" && outcome.error).toContain("locked");
  // Lost, not held for later: a flush after has nothing to write.
  expect(await s.flush()).toMatchObject({ kind: "written", records: 0 });
  expect((await openRecordStore({ path }).getMany("file", [k("x")])).size).toBe(
    0,
  );
});

test("a key written or read since a value went stale keeps the value through the reclaim", async () => {
  const path = join(dir, "reclaim-revived.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [
    [k("written-old"), "written"],
    [k("read-old"), "read"],
  ]);
  await s.flush();
  age(path);
  // Another build stores a new key naming one stale value, and reads the
  // other's key: each moves its value's day with it.
  const writer = openRecordStore({ path });
  writer.putMany("facet", [[k("written-new"), "written"]]);
  await writer.flush();
  const reader = openRecordStore({ path });
  expect(
    (await reader.getMany("file", [k("read-old")])).get(k("read-old")),
  ).toBe("read");
  // The refresh is written off the read's path: wait for it to land.
  const db = new Database(path, { readonly: true });
  const day = (key: string) =>
    db
      .query(
        "SELECT k.used AS key, v.used AS value FROM keys k JOIN vals v ON v.id = k.val WHERE k.key = ?",
      )
      .get(Buffer.from(key, "hex")) as { key: number; value: number };
  const fresh = day(k("written-new")).key;
  for (let i = 0; i < 200 && day(k("read-old")).value < fresh; i++)
    await Bun.sleep(10);
  expect(day(k("read-old"))).toEqual({ key: fresh, value: fresh });
  expect(day(k("written-new"))).toEqual({ key: fresh, value: fresh });
  db.close();
  expect(await reclaimRecordStore({ path })).toMatchObject({
    keysDeleted: 1,
    valuesDeleted: 0,
  });
  const after = openRecordStore({ path });
  expect([
    ...(await after.getMany("file", [k("written-old"), k("read-old")])),
  ]).toEqual([[k("read-old"), "read"]]);
  expect(
    (await after.getMany("facet", [k("written-new")])).get(k("written-new")),
  ).toBe("written");
});

test("a key whose value is gone is written again, not dropped as stored", async () => {
  const path = join(dir, "dangling.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [[k("d"), "v"]]);
  await s.flush();
  const db = new Database(path);
  db.exec("DELETE FROM vals");
  db.close();
  const again = openRecordStore({ path });
  // A new value never takes the gone one's id: the key reads as a miss,
  // never as another record's value.
  again.putMany("file", [[k("other"), "other"]]);
  await again.flush();
  expect((await again.getMany("file", [k("d")])).size).toBe(0);
  again.putMany("file", [[k("d"), "v"]]);
  await again.flush();
  expect(
    (await openRecordStore({ path }).getMany("file", [k("d")])).get(k("d")),
  ).toBe("v");
});

test("a value reclaimed and put again is a fresh row, read under its key", async () => {
  const path = join(dir, "reclaim-reput.sqlite");
  const s = openRecordStore({ path });
  s.putMany("file", [[k("r"), "same"]]);
  await s.flush();
  age(path);
  expect(await reclaimRecordStore({ path })).toMatchObject({
    keysDeleted: 1,
    valuesDeleted: 1,
  });
  const writer = openRecordStore({ path });
  writer.putMany("file", [[k("r"), "same"]]);
  await writer.flush();
  expect(
    (await openRecordStore({ path }).getMany("file", [k("r")])).get(k("r")),
  ).toBe("same");
  const db = new Database(path, { readonly: true });
  // Ids are never reused: the fresh row is the second.
  expect(db.query("SELECT id FROM vals").all()).toEqual([{ id: 2 }]);
  db.close();
});
