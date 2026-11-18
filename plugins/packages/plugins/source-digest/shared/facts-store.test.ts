import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSourceFacts } from "./facts-store";

const dir = mkdtempSync(join(tmpdir(), "facts-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("the prune deletes only rows unread for 14 days, across pages, and stamps the marker", async () => {
  const path = join(dir, "facts.sqlite");
  const day = 20_000;
  // An empty store: creates the schema, deletes nothing.
  expect((await pruneSourceFacts({ path, day })).rowsRead).toBe(0);
  const db = new Database(path);
  const put = db.query(
    "INSERT INTO facts (scanner, path, stamp, sha256, imports, used) VALUES (?, ?, 's', 'h', '[]', ?)",
  );
  // Two scanners, 1,500 rows each (pages cross the scanner boundary); even
  // rows last read 15 days ago, odd ones 14 days ago (kept: the cutoff is
  // strictly older than 14 days).
  db.transaction(() => {
    for (const scanner of ["a", "b"])
      for (let i = 0; i < 1500; i++)
        put.run(scanner, `f${i}`, i % 2 === 0 ? day - 15 : day - 14);
  })();

  const r = await pruneSourceFacts({ path, day });
  expect(r.rowsRead).toBe(3000);
  expect(r.rowsDeleted).toBe(1500);
  expect(r.transactions).toBeGreaterThan(1);
  expect(
    db.query("SELECT count(*) AS n FROM facts WHERE used < ?").get(day - 14),
  ).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM facts").get()).toEqual({
    n: 1500,
  });
  expect(
    db.query("SELECT value FROM meta WHERE name = 'pruned'").get(),
  ).toEqual({ value: String(day) });
  db.close();
});
