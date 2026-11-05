import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGrepIndexStore } from "./grep-index-store";

const dir = mkdtempSync(join(tmpdir(), "grep-index-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

test("answers round-trip per query, survive a reopen, and keep the first value", () => {
  const path = join(dir, "grep-index.sqlite");
  const store = openGrepIndexStore({ path });
  store.record("q1", [
    [A, true],
    [B, false],
  ]);
  store.record("q2", [[A, false]]);
  expect(store.answers("q1", [A, B, C])).toEqual(
    new Map([
      [A, true],
      [B, false],
    ]),
  );
  expect(store.answers("q2", [A, B])).toEqual(new Map([[A, false]]));

  const reopened = openGrepIndexStore({ path });
  reopened.record("q1", [[A, false]]);
  expect(reopened.answers("q1", [A])).toEqual(new Map([[A, true]]));
  expect(reopened.answers("q3", [A])).toEqual(new Map());
});

test("a lookup wider than one statement's batch answers every blob", () => {
  const store = openGrepIndexStore({ path: join(dir, "wide.sqlite") });
  const blobs = Array.from({ length: 1234 }, (_, i) =>
    i.toString(16).padStart(40, "0"),
  );
  store.record(
    "q",
    blobs.map((b, i) => [b, i % 3 === 0] as const),
  );
  const got = store.answers("q", blobs);
  expect(got.size).toBe(blobs.length);
  expect(got.get(blobs[3]!)).toBe(true);
  expect(got.get(blobs[4]!)).toBe(false);
});
