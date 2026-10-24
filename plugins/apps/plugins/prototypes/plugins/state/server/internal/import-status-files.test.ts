import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatusFiles, type StatusFileRow } from "./import-status-files";

const A = "proto-1792526257-f0gpsa";
const B = "proto-1786877040-w2vi";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "status-import-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readStatusFiles", () => {
  test("one row per record, an absent field reading false", () => {
    writeFileSync(join(dir, `${A}.json`), '{"done":true,"pinned":false}');
    writeFileSync(join(dir, `${B}.json`), '{"done":true}');
    const rows = readStatusFiles(dir)
      .map((r): [string, boolean, boolean] => [r.id, r.done, r.pinned])
      .sort(([x], [y]) => x.localeCompare(y));
    expect(rows).toEqual([
      [B, true, false],
      [A, true, false],
    ]);
  });

  test("deletedAt is read as a Date, absent or null as not deleted", () => {
    writeFileSync(
      join(dir, `${A}.json`),
      '{"done":false,"pinned":false,"deletedAt":"2026-10-23T23:51:16.707Z"}',
    );
    writeFileSync(join(dir, `${B}.json`), '{"done":true,"deletedAt":null}');
    const byId = new Map<string, StatusFileRow>(
      readStatusFiles(dir).map((r) => [r.id, r]),
    );
    expect(byId.get(A)?.deletedAt?.toISOString()).toBe(
      "2026-10-23T23:51:16.707Z",
    );
    expect(byId.get(B)?.deletedAt).toBeNull();
  });

  test("skips locks, temp files, non-ids and dirs", () => {
    writeFileSync(join(dir, `${A}.lock`), "");
    writeFileSync(join(dir, `${A}.json.tmp`), "{}");
    writeFileSync(join(dir, "not-an-id.json"), "{}");
    mkdirSync(join(dir, `${B}.json`));
    expect(readStatusFiles(dir)).toEqual([]);
  });

  test("a malformed record throws, naming the file", () => {
    writeFileSync(join(dir, `${A}.json`), '{"done":"yes"}');
    expect(() => readStatusFiles(dir)).toThrow(`${A}.json`);
  });
});
