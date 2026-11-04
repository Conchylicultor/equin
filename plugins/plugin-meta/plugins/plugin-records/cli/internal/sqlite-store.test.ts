import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecordStore } from "./sqlite-store";

const dir = mkdtempSync(join(tmpdir(), "plugin-records-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("records survive a reopen, per table, and a present key keeps its value", () => {
  const path = join(dir, "records.sqlite");
  const a = openRecordStore({ path });
  a.putMany("facet", [
    ["k1", "v1"],
    ["k2", "v2"],
  ]);
  a.putMany("facet", [["k1", "other"]]);
  const b = openRecordStore({ path });
  expect([...b.getMany("facet", ["k1", "k2", "k3"])]).toEqual([
    ["k1", "v1"],
    ["k2", "v2"],
  ]);
  expect(b.getMany("file", ["k1"]).size).toBe(0);
});

test("a batch larger than one statement's parameters is read whole", () => {
  const s = openRecordStore({ path: join(dir, "big.sqlite") });
  const entries = Array.from(
    { length: 1234 },
    (_, i) => [`k${i}`, `v${i}`] as const,
  );
  s.putMany("module", entries);
  expect(
    s.getMany(
      "module",
      entries.map(([k]) => k),
    ).size,
  ).toBe(1234);
});
