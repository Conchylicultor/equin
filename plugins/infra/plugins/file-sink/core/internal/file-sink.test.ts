import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineFileSink, getFileSinks, openDynamicSink } from "./file-sink";

const TEST_CONSUMER = { kind: "internal", note: "test" } as const;

// Hermetic: every sink writes into an isolated temp dir. The registry is
// process-global (a sink is declared exactly once), so each test uses a UNIQUE id
// to avoid cross-test collisions. `defineFileSink` takes an explicit maxBytes/keep
// so rotation is forced with a tiny cap instead of writing 128 MB.

let dir: string;
let counter = 0;
function uniqueId(): string {
  return `test-sink-${process.pid}-${counter++}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-sink-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rotatedFiles(base: string): string[] {
  return readdirSync(dir)
    .filter((n) => new RegExp(`^${base}\\.\\d+$`).test(n))
    .sort();
}

describe("defineFileSink rotation", () => {
  test("appends under the cap without rotating", () => {
    const path = join(dir, "a.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.append("line-1");
    sink.append("line-2");

    expect(readFileSync(path, "utf8").trim().split("\n")).toEqual([
      "line-1",
      "line-2",
    ]);
    expect(existsSync(path + ".1")).toBe(false);
  });

  test("rotates once the cap is crossed and keeps the live file small", () => {
    const path = join(dir, "b.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 10, // "line-1\n" is 7 bytes: the 2nd append (7+7=14) crosses it.
      keep: 3,
    });
    sink.append("line-1"); // seeds the live file (7 ≤ 10)
    sink.append("line-2"); // 7 + 7 > 10 → rotate, then fresh write

    // Live file holds only the post-rotation line.
    expect(
      readFileSync(path, "utf8").trim().split("\n").filter(Boolean),
    ).toEqual(["line-2"]);
    // The rotated file exists and holds the pre-rotation content.
    expect(existsSync(path + ".1")).toBe(true);
    expect(readFileSync(path + ".1", "utf8").trim()).toBe("line-1");
  });

  test("keeps at most `keep` rotated files; oldest is unlinked (window shifts .1→.2→.3)", () => {
    const path = join(dir, "c.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 5, // "L0\n" is 3 bytes: every subsequent append rotates.
      keep: 3,
    });
    for (let i = 0; i < 8; i++) sink.append(`L${i}`);

    // keep is 3 — never more, regardless of how many rotations occurred.
    expect(rotatedFiles("c\\.jsonl")).toEqual([
      "c.jsonl.1",
      "c.jsonl.2",
      "c.jsonl.3",
    ]);
    expect(existsSync(path + ".4")).toBe(false);
    // Newest rotation is .1; the window shifts down; the oldest was unlinked.
    expect(readFileSync(path, "utf8").trim()).toBe("L7");
    expect(readFileSync(path + ".1", "utf8").trim()).toBe("L6");
    expect(readFileSync(path + ".2", "utf8").trim()).toBe("L5");
    expect(readFileSync(path + ".3", "utf8").trim()).toBe("L4");
  });

  test("bound reflects defaults (128 MB × 3) when unset", () => {
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path: join(dir, "f.jsonl"),
    });
    expect(sink.bound).toEqual({
      kind: "rotate",
      maxBytes: 128 * 1024 * 1024,
      keep: 3,
    });
  });
});

describe("appendAll", () => {
  // The batch form shares ONE implementation (and one size gate) with `append`,
  // so these assert the observable invariants that sharing must preserve. No
  // syscall counting: `appendFileSync` is a bound ESM import, and mocking it
  // would be more fragile than the test is worth.

  test("writes a whole batch under the cap in order, into one file", () => {
    const path = join(dir, "ba.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendAll(["b0", "b1", "b2", "b3", "b4"]);

    expect(readFileSync(path, "utf8")).toBe("b0\nb1\nb2\nb3\nb4\n");
    expect(existsSync(path + ".1")).toBe(false);
  });

  test("an empty batch creates neither the file nor its directory", () => {
    // Asking for nothing must not bring a file — or a whole dir tree — into
    // existence as a side effect.
    const nested = join(dir, "nope", "deeper");
    const path = join(nested, "bb.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendAll([]);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(join(dir, "nope"))).toBe(false);
  });

  test("a batch crossing the cap splits BETWEEN lines, never inside one", () => {
    // The invariant every reader depends on: rotation happens between two whole
    // lines, so `.1` followed by the live file reads back as the input verbatim.
    const path = join(dir, "bc.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 12, // "L0\n" is 3 bytes → 4 lines fill the file exactly
      keep: 3,
    });
    const lines = ["L0", "L1", "L2", "L3", "L4", "L5"];
    sink.appendAll(lines);

    const rotated = readFileSync(path + ".1", "utf8");
    const live = readFileSync(path, "utf8");
    // Every written byte is part of a "\n"-terminated line, in both files.
    expect(rotated.endsWith("\n")).toBe(true);
    expect(live.endsWith("\n")).toBe(true);
    expect((rotated + live).split("\n").filter(Boolean)).toEqual(lines);
    expect(rotated.split("\n").filter(Boolean)).toEqual([
      "L0",
      "L1",
      "L2",
      "L3",
    ]);
    expect(live.split("\n").filter(Boolean)).toEqual(["L4", "L5"]);
  });

  test("the gate is `>`, not `>=`: exactly maxBytes does not rotate", () => {
    const exact = join(dir, "bd.jsonl");
    const exactSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path: exact,
      maxBytes: 12, // 3 × "aaa\n" = 12 bytes exactly
      keep: 3,
    });
    exactSink.appendAll(["aaa", "aaa", "aaa"]);
    expect(existsSync(exact + ".1")).toBe(false);
    expect(readFileSync(exact, "utf8")).toBe("aaa\naaa\naaa\n");

    // One byte less of budget and the same batch must rotate.
    const over = join(dir, "be.jsonl");
    const overSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path: over,
      maxBytes: 11,
      keep: 3,
    });
    overSink.appendAll(["aaa", "aaa", "aaa"]);
    expect(readFileSync(over + ".1", "utf8")).toBe("aaa\naaa\n");
    expect(readFileSync(over, "utf8")).toBe("aaa\n");
  });

  test("a batch far past maxBytes × (keep + 1) still respects `keep`", () => {
    // Several rotations inside the ONE call; `keep` stays a hard cap and the live
    // file holds the batch's tail.
    const path = join(dir, "bf.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 6, // 2 lines per rotation group
      keep: 2,
    });
    sink.appendAll([
      "L0",
      "L1",
      "L2",
      "L3",
      "L4",
      "L5",
      "L6",
      "L7",
      "L8",
      "L9",
    ]);

    expect(rotatedFiles("bf\\.jsonl")).toEqual(["bf.jsonl.1", "bf.jsonl.2"]);
    expect(readFileSync(path, "utf8")).toBe("L8\nL9\n");
    expect(readFileSync(path + ".1", "utf8")).toBe("L6\nL7\n");
    expect(readFileSync(path + ".2", "utf8")).toBe("L4\nL5\n");
  });

  test("a single line larger than maxBytes is written whole, after its predecessors", () => {
    const path = join(dir, "bg.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 10,
      keep: 3,
    });
    const big = "X".repeat(50);
    sink.appendAll(["aa", "bb", big]);

    // The group in hand belongs to the pre-rotation file…
    expect(readFileSync(path + ".1", "utf8")).toBe("aa\nbb\n");
    // …and the oversized line lands whole, never split or truncated to the cap.
    expect(readFileSync(path, "utf8")).toBe(big + "\n");
  });

  test("an oversized line into an empty file burns no rotation slot", () => {
    // Deliberate difference from the old per-line gate: rotating first would
    // evict real history to make room for a line that overflows either way.
    const path = join(dir, "bh.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 10,
      keep: 3,
    });
    const big = "Y".repeat(50);
    sink.appendAll([big]);

    expect(readFileSync(path, "utf8")).toBe(big + "\n");
    expect(rotatedFiles("bh\\.jsonl")).toEqual([]);
  });

  test("appendAll(lines) is byte-identical to looping append(line)", () => {
    // The anti-drift test: if the two forms are ever re-split into two size
    // gates, this is what fails.
    const loopPath = join(dir, "bi.jsonl");
    const batchPath = join(dir, "bj.jsonl");
    const opts = { maxBytes: 12, keep: 3 } as const;
    const loopSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path: loopPath,
      ...opts,
    });
    const batchSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path: batchPath,
      ...opts,
    });

    // 10 × 3 bytes over a 12-byte cap → two rotations.
    const lines = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"];
    for (const line of lines) loopSink.append(line);
    batchSink.appendAll(lines);

    expect(rotatedFiles("bi\\.jsonl")).toEqual(["bi.jsonl.1", "bi.jsonl.2"]);
    expect(rotatedFiles("bj\\.jsonl")).toEqual(["bj.jsonl.1", "bj.jsonl.2"]);
    for (const suffix of ["", ".1", ".2"]) {
      expect(readFileSync(batchPath + suffix, "utf8")).toBe(
        readFileSync(loopPath + suffix, "utf8"),
      );
    }
  });

  test("recreates the parent dir if it disappeared under a live sink", () => {
    // The mkdir moved from "before every write" to "on the write's ENOENT", so
    // the self-healing has to survive the move: a worktree teardown that removes
    // the logs dir must not wedge a sink that is still being written to.
    const path = join(dir, "bk.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      consumer: TEST_CONSUMER,
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.append("before");
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);

    sink.appendAll(["after-1", "after-2"]);
    expect(readFileSync(path, "utf8")).toBe("after-1\nafter-2\n");
  });
});

describe("defineFileSink / getFileSinks registry", () => {
  test("a duplicate id throws (declared exactly once)", () => {
    const id = uniqueId();
    defineFileSink({
      id,
      description: "t",
      consumer: TEST_CONSUMER,
      path: join(dir, "d.jsonl"),
    });
    expect(() =>
      defineFileSink({
        id,
        description: "t",
        consumer: TEST_CONSUMER,
        path: join(dir, "d2.jsonl"),
      }),
    ).toThrow(/already defined/);
  });

  test("getFileSinks returns a copy, not the live map", () => {
    const id = uniqueId();
    const sink = defineFileSink({
      id,
      description: "t",
      consumer: TEST_CONSUMER,
      path: join(dir, "e.jsonl"),
    });
    const first = getFileSinks() as Map<string, unknown>;
    first.delete(id);
    first.set("intruder", {});

    const second = getFileSinks();
    expect(second.get(id)).toBe(sink);
    expect(second.has("intruder")).toBe(false);
  });
});

describe("openDynamicSink", () => {
  test("sanitizes the name into the dir, rotates, and is NOT registered", () => {
    const before = getFileSinks().size;
    const sink = openDynamicSink(dir, "weird/name!");
    // Path-traversal-safe: every non-[A-Za-z0-9_-] char becomes "_".
    expect(sink.path).toBe(join(dir, "weird_name_.jsonl"));

    sink.append("x");
    expect(existsSync(join(dir, "weird_name_.jsonl"))).toBe(true);
    // A dynamic sink is covered by one family bound, not the registry.
    expect(getFileSinks().size).toBe(before);
  });
});
