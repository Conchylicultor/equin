/**
 * The release transcript's line index: lines keyed by their padded line
 * number, memoized on the file's `(size, mtime)`, and paged by
 * `releaseRunLogs` within its key contract.
 *
 * Run: `./equin test plugins/release`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import { releaseRunLogs } from "../../core/resources";
import { readLineIndex, type LineIndex } from "./transcript";

let dir: string;
let path: string;
let cache: Map<string, LineIndex>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-transcript-"));
  path = join(dir, "run.log");
  cache = new Map();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLineIndex", () => {
  test("keys each line by its padded 1-based number, keeping an unterminated last line", async () => {
    writeFileSync(path, "one\ntwo\nthree");
    expect(await readLineIndex(path, cache, "r")).toEqual([
      { n: "000000001", text: "one", stream: "stdout" },
      { n: "000000002", text: "two", stream: "stdout" },
      { n: "000000003", text: "three", stream: "stdout" },
    ]);
  });

  test("drops only the empty piece after a final newline", async () => {
    writeFileSync(path, "one\n\ntwo\n");
    expect((await readLineIndex(path, cache, "r")).map((l) => l.text)).toEqual([
      "one",
      "",
      "two",
    ]);
  });

  test("an unchanged (size, mtime) hands back the memoized lines", async () => {
    writeFileSync(path, "one\n");
    const first = await readLineIndex(path, cache, "r");
    expect(await readLineIndex(path, cache, "r")).toBe(first);
  });

  test("an append re-reads", async () => {
    writeFileSync(path, "one\n");
    const first = await readLineIndex(path, cache, "r");
    appendFileSync(path, "two\n");
    // A distinct mtime, whatever the filesystem's clock resolution.
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    const next = await readLineIndex(path, cache, "r");
    expect(next).not.toBe(first);
    expect(next.map((l) => l.text)).toEqual(["one", "two"]);
  });

  test("a missing file reads as no lines and forgets the memo", async () => {
    writeFileSync(path, "one\n");
    await readLineIndex(path, cache, "r");
    rmSync(path);
    expect(await readLineIndex(path, cache, "r")).toEqual([]);
    expect(cache.has("r")).toBe(false);
  });

  test("pages within releaseRunLogs' key contract (newest first)", async () => {
    writeFileSync(
      path,
      Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const items = await readLineIndex(path, cache, "r");
    await checkPagedSource({
      value: releaseRunLogs,
      query: { id: "r" },
      loader: (_q, range) => sliceRange(releaseRunLogs, items, range),
      items,
      limits: [1, 5],
    });
    const page0 = sliceRange(releaseRunLogs, items, {
      after: null,
      until: null,
      limit: 3,
    });
    expect(page0.map((l) => l.text)).toEqual(["line 12", "line 11", "line 10"]);
  });
});
