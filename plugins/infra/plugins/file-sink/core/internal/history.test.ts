import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFileSink } from "./file-sink";
import type { FileSink } from "./types";
import { historyCutAt, readHistory, statHistory } from "./history";

let dir: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-sink-history-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (i: number): string =>
  JSON.stringify({ t: 1_000 + i, line: `line ${String(i).padStart(3, "0")}` });

/** A sink rotating every 4 lines, keeping 3 rotations. */
function rotatingSink(): FileSink {
  return defineFileSink({
    id: `history-test-${n++}`,
    description: "test",
    path: join(dir, "h.jsonl"),
    maxBytes: line(0).length * 4 + 4,
    keep: 3,
  });
}

async function write(sink: FileSink, from: number, to: number): Promise<void> {
  for (let i = from; i < to; i++) {
    sink.append(line(i));
    // A fresh file is born on the append after a rotation: space them out so
    // no two files share a birth microsecond.
    await Bun.sleep(2);
  }
}

async function writeRotating(count: number): Promise<string> {
  const sink = rotatingSink();
  await write(sink, 0, count);
  return sink.path;
}

async function readAll(path: string, limit: number): Promise<string[]> {
  const all: string[] = [];
  let before: string | null = null;
  for (;;) {
    const page = await readHistory(path, { before, notBefore: null, limit });
    for (const l of page) all.push(l.text);
    if (page.length < limit) return all;
    before = page[page.length - 1]!.position;
  }
}

describe("readHistory", () => {
  test("pages newest-first across every kept generation, at any page size", async () => {
    const path = await writeRotating(18);
    const files = await statHistory(path);
    expect(files.map((f) => f.generation)).toEqual([0, 1, 2, 3]);
    // 18 lines, 4 per file: the live file holds 16–17, `.1`–`.3` hold 4–15, and
    // 0–3 were deleted past `keep`.
    const expected = Array.from({ length: 14 }, (_, i) => line(17 - i));
    for (const limit of [1, 3, 5, 100]) {
      expect(await readAll(path, limit)).toEqual(expected);
    }
  });

  test("a cut survives a rotation: the next page continues from the same line", async () => {
    const sink = rotatingSink();
    await write(sink, 0, 6);
    const first = await readHistory(sink.path, {
      before: null,
      notBefore: null,
      limit: 3,
    });
    expect(first.map((l) => l.text)).toEqual([line(5), line(4), line(3)]);
    expect(first.map((l) => l.generation)).toEqual([0, 0, 1]);
    // Rotate twice more: the lines the cut sits between move to `.2` / `.3`.
    await write(sink, 6, 14);
    const next = await readHistory(sink.path, {
      before: first[2]!.position,
      notBefore: null,
      limit: 3,
    });
    expect(next.map((l) => l.text)).toEqual([line(2), line(1), line(0)]);
    expect(next.map((l) => l.generation)).toEqual([3, 3, 3]);
  });

  test("an unterminated tail (an append in flight) is not a line", async () => {
    const path = join(dir, "t.jsonl");
    appendFileSync(path, `${line(0)}\n${line(1)}\n{"t":3,"li`);
    const page = await readHistory(path, {
      before: null,
      notBefore: null,
      limit: 10,
    });
    expect(page.map((l) => l.text)).toEqual([line(1), line(0)]);
  });

  test("notBefore stops the walk at a position", async () => {
    const path = await writeRotating(8);
    const all = await readHistory(path, {
      before: null,
      notBefore: null,
      limit: 100,
    });
    const stop = all[3]!.position;
    const bounded = await readHistory(path, {
      before: null,
      notBefore: stop,
      limit: 100,
    });
    expect(bounded.map((l) => l.text)).toEqual(
      all.slice(0, 4).map((l) => l.text),
    );
  });

  test("a missing history reads as no lines", async () => {
    expect(await statHistory(join(dir, "none.jsonl"))).toEqual([]);
    expect(
      await readHistory(join(dir, "none.jsonl"), {
        before: null,
        notBefore: null,
        limit: 5,
      }),
    ).toEqual([]);
  });
});

describe("historyCutAt", () => {
  const timeOf = (l: string): number | null =>
    (JSON.parse(l) as { t: number }).t;

  test("reads back from the newest line at or before an instant, in any generation", async () => {
    const path = await writeRotating(14);
    for (const i of [2, 5, 9, 13]) {
      const cut = await historyCutAt(path, 1_000 + i, timeOf);
      expect(cut).not.toBeNull();
      const page = await readHistory(path, {
        before: cut,
        notBefore: null,
        limit: 1,
      });
      expect(page[0]!.text).toBe(line(i));
    }
  });

  test("null when every kept line is newer", async () => {
    const path = await writeRotating(14);
    expect(await historyCutAt(path, 0, timeOf)).toBeNull();
  });
});
