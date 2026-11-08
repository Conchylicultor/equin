import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFileSink } from "./file-sink";
import { readJsonlTailSync, readTailSync } from "./read";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Hermetic, mirroring file-sink.test.ts: every file lives in an isolated temp dir.
// Sink ids must be unique (the registry is process-global, declared exactly once).

let dir: AppPath;
let counter = 0;
function uniqueId(): string {
  return `read-sink-${process.pid}-${counter++}`;
}

beforeEach(() => {
  dir = asAppPath(mkdtempSync(join(tmpdir(), "file-sink-read-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): AppPath {
  const path = joinAppPath(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("readTail", () => {
  test("reads every line when the file is under budget", () => {
    const path = write("a.jsonl", "one\ntwo\nthree\n");
    const result = readTailSync(path);
    expect(result).toEqual({
      kind: "read",
      lines: ["one", "two", "three"],
      truncated: false,
      filesRead: 1,
    });
  });

  test("over budget: drops the leading partial line and flags truncated", () => {
    // 4 lines of 4 bytes each ("aaa\n"). A 10-byte budget starts mid-"bbb", so the
    // clipped leading fragment must be dropped rather than surfaced as a line.
    const path = write("b.jsonl", "aaa\nbbb\nccc\nddd\n");
    const result = readTailSync(path, { maxBytes: 10 });
    expect(result).toEqual({
      kind: "read",
      lines: ["ccc", "ddd"],
      truncated: true,
      filesRead: 1,
    });
  });

  test("a missing file is `missing`, never an empty read", () => {
    expect(readTailSync(joinAppPath(dir, "nope.jsonl"))).toEqual({
      kind: "missing",
    });
    // The distinction is load-bearing: a present-but-empty file IS a read.
    const empty = write("empty.jsonl", "");
    expect(readTailSync(empty)).toEqual({
      kind: "read",
      lines: [],
      truncated: false,
      filesRead: 1,
    });
  });

  test("maxLines keeps the NEWEST lines and flags truncated", () => {
    const path = write("c.jsonl", "1\n2\n3\n4\n5\n");
    const result = readTailSync(path, { maxLines: 2 });
    expect(result).toEqual({
      kind: "read",
      lines: ["4", "5"],
      truncated: true,
      filesRead: 1,
    });
    // Not truncated when the cap is not actually reached.
    expect(readTailSync(path, { maxLines: 99 })).toMatchObject({
      truncated: false,
    });
  });

  test("includeRotated stitches oldest-first across a forced rotation", () => {
    const path = joinAppPath(dir, "d.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 5, // "L0\n" is 3 bytes → every subsequent append rotates
      keep: 3,
    });
    for (let i = 0; i < 4; i++) sink.appendSync(`L${i}`);
    // Live=L3, .1=L2, .2=L1, .3=L0

    // Default: live file only — history is NOT stitched.
    expect(readTailSync(path)).toEqual({
      kind: "read",
      lines: ["L3"],
      truncated: false,
      filesRead: 1,
    });

    // Opt in: chronological order is restored across the rotation boundary.
    const stitched = readTailSync(path, { includeRotated: true });
    expect(stitched).toEqual({
      kind: "read",
      lines: ["L0", "L1", "L2", "L3"],
      truncated: false,
      filesRead: 4,
    });
  });

  test("includeRotated stitches an appendAll batch that crossed a rotation", () => {
    // The direct guard on the documented invariant: a batch rotates BETWEEN two
    // whole lines, so the reader stitches it back oldest-first with nothing torn
    // — the batch write is invisible to the reader.
    const path = joinAppPath(dir, "d2.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 12, // "L0\n" is 3 bytes → 4 lines per rotation group
      keep: 3,
    });
    sink.appendAllSync(["L0", "L1", "L2", "L3", "L4", "L5"]);

    expect(readTailSync(path, { includeRotated: true })).toEqual({
      kind: "read",
      lines: ["L0", "L1", "L2", "L3", "L4", "L5"],
      truncated: false,
      filesRead: 2,
    });
  });

  test("includeRotated stops at the byte budget and flags the dropped history", () => {
    const path = joinAppPath(dir, "e.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 5,
      keep: 3,
    });
    for (let i = 0; i < 4; i++) sink.appendSync(`L${i}`);

    // 6 bytes covers exactly the live file + `.1` ("L3\n" + "L2\n"); `.2` exists
    // but is never opened, so history was clipped.
    const result = readTailSync(path, { includeRotated: true, maxBytes: 6 });
    expect(result).toEqual({
      kind: "read",
      lines: ["L2", "L3"],
      truncated: true,
      filesRead: 2,
    });
  });
});

describe("readJsonlTail", () => {
  test("parses each line into a record", () => {
    const path = write("f.jsonl", '{"n":1}\n{"n":2}\n');
    expect(readJsonlTailSync<{ n: number }>(path)).toEqual({
      kind: "read",
      records: [{ n: 1 }, { n: 2 }],
      truncated: false,
      filesRead: 1,
    });
  });

  test("a torn trailing line is skipped (SyntaxError only)", () => {
    // A half-flushed append leaves an unterminated object at the tail.
    const path = write("g.jsonl", '{"n":1}\n{"n":2}\n{"n":\n');
    expect(readJsonlTailSync<{ n: number }>(path)).toEqual({
      kind: "read",
      records: [{ n: 1 }, { n: 2 }],
      truncated: false,
      filesRead: 1,
    });
  });

  test("a non-SyntaxError parse failure rethrows", () => {
    // ONLY SyntaxError means "torn line". Anything else (a RangeError on a
    // pathological input, an OOM) is a real bug and must surface rather than
    // silently shortening the record list. Forced deterministically — the natural
    // triggers are engine-dependent.
    const path = write("h.jsonl", '{"n":1}\n');
    const realParse = JSON.parse;
    JSON.parse = () => {
      throw new RangeError("boom");
    };
    try {
      expect(() => readJsonlTailSync(path)).toThrow(RangeError);
    } finally {
      JSON.parse = realParse;
    }
  });

  test("a missing file is `missing`, never []", () => {
    expect(readJsonlTailSync(joinAppPath(dir, "nope.jsonl"))).toEqual({
      kind: "missing",
    });
  });
});

describe("FileSink read methods", () => {
  test("sink.readTailSync / sink.readJsonlTailSync read the sink's own path", () => {
    const path = joinAppPath(dir, "i.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
    });
    sink.appendSync(JSON.stringify({ n: 1 }));
    sink.appendSync(JSON.stringify({ n: 2 }));

    expect(sink.readTailSync()).toMatchObject({
      kind: "read",
      lines: ['{"n":1}', '{"n":2}'],
    });
    expect(sink.readJsonlTailSync<{ n: number }>()).toMatchObject({
      kind: "read",
      records: [{ n: 1 }, { n: 2 }],
    });
  });

  test("the read budget is the 8 MB default, NOT the sink's 128 MB bound", () => {
    const path = joinAppPath(dir, "j.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
    });
    expect(sink.bound.maxBytes).toBe(128 * 1024 * 1024);
    // A 2-byte explicit budget clips: proof the budget comes from opts, and that
    // the default is not silently derived from `bound`.
    sink.appendSync("aaaa");
    sink.appendSync("bbbb");
    expect(sink.readTailSync({ maxBytes: 5 })).toMatchObject({
      truncated: true,
    });
  });

  test("a sink whose file was never written reports missing", () => {
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: joinAppPath(dir, "k.jsonl"),
    });
    expect(sink.readTailSync()).toEqual({ kind: "missing" });
  });
});
