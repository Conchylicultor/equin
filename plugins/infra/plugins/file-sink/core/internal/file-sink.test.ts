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
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// Hermetic: every sink writes into an isolated temp dir. The registry is
// process-global (a sink is declared exactly once), so each test uses a UNIQUE id
// to avoid cross-test collisions. `defineFileSink` takes an explicit maxBytes/keep
// so rotation is forced with a tiny cap instead of writing 128 MB.

let dir: AppPath;
let counter = 0;
function uniqueId(): string {
  return `test-sink-${process.pid}-${counter++}`;
}

beforeEach(() => {
  dir = asAppPath(mkdtempSync(join(tmpdir(), "file-sink-")));
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
    const path = joinAppPath(dir, "a.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendSync("line-1");
    sink.appendSync("line-2");

    expect(readFileSync(path, "utf8").trim().split("\n")).toEqual([
      "line-1",
      "line-2",
    ]);
    expect(existsSync(path + ".1")).toBe(false);
  });

  test("rotates once the cap is crossed and keeps the live file small", () => {
    const path = joinAppPath(dir, "b.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 10, // "line-1\n" is 7 bytes: the 2nd append (7+7=14) crosses it.
      keep: 3,
    });
    sink.appendSync("line-1"); // seeds the live file (7 ≤ 10)
    sink.appendSync("line-2"); // 7 + 7 > 10 → rotate, then fresh write

    // Live file holds only the post-rotation line.
    expect(
      readFileSync(path, "utf8").trim().split("\n").filter(Boolean),
    ).toEqual(["line-2"]);
    // The rotated file exists and holds the pre-rotation content.
    expect(existsSync(path + ".1")).toBe(true);
    expect(readFileSync(path + ".1", "utf8").trim()).toBe("line-1");
  });

  test("keeps at most `keep` rotated files; oldest is unlinked (window shifts .1→.2→.3)", () => {
    const path = joinAppPath(dir, "c.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 5, // "L0\n" is 3 bytes: every subsequent append rotates.
      keep: 3,
    });
    for (let i = 0; i < 8; i++) sink.appendSync(`L${i}`);

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
      path: joinAppPath(dir, "f.jsonl"),
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
    const path = joinAppPath(dir, "ba.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendAllSync(["b0", "b1", "b2", "b3", "b4"]);

    expect(readFileSync(path, "utf8")).toBe("b0\nb1\nb2\nb3\nb4\n");
    expect(existsSync(path + ".1")).toBe(false);
  });

  test("an empty batch creates neither the file nor its directory", () => {
    // Asking for nothing must not bring a file — or a whole dir tree — into
    // existence as a side effect.
    const nested = joinAppPath(dir, "nope", "deeper");
    const path = joinAppPath(nested, "bb.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendAllSync([]);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(joinAppPath(dir, "nope"))).toBe(false);
  });

  test("a batch crossing the cap splits BETWEEN lines, never inside one", () => {
    // The invariant every reader depends on: rotation happens between two whole
    // lines, so `.1` followed by the live file reads back as the input verbatim.
    const path = joinAppPath(dir, "bc.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 12, // "L0\n" is 3 bytes → 4 lines fill the file exactly
      keep: 3,
    });
    const lines = ["L0", "L1", "L2", "L3", "L4", "L5"];
    sink.appendAllSync(lines);

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
    const exact = joinAppPath(dir, "bd.jsonl");
    const exactSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: exact,
      maxBytes: 12, // 3 × "aaa\n" = 12 bytes exactly
      keep: 3,
    });
    exactSink.appendAllSync(["aaa", "aaa", "aaa"]);
    expect(existsSync(exact + ".1")).toBe(false);
    expect(readFileSync(exact, "utf8")).toBe("aaa\naaa\naaa\n");

    // One byte less of budget and the same batch must rotate.
    const over = joinAppPath(dir, "be.jsonl");
    const overSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: over,
      maxBytes: 11,
      keep: 3,
    });
    overSink.appendAllSync(["aaa", "aaa", "aaa"]);
    expect(readFileSync(over + ".1", "utf8")).toBe("aaa\naaa\n");
    expect(readFileSync(over, "utf8")).toBe("aaa\n");
  });

  test("a batch far past maxBytes × (keep + 1) still respects `keep`", () => {
    // Several rotations inside the ONE call; `keep` stays a hard cap and the live
    // file holds the batch's tail.
    const path = joinAppPath(dir, "bf.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 6, // 2 lines per rotation group
      keep: 2,
    });
    sink.appendAllSync([
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
    const path = joinAppPath(dir, "bg.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 10,
      keep: 3,
    });
    const big = "X".repeat(50);
    sink.appendAllSync(["aa", "bb", big]);

    // The group in hand belongs to the pre-rotation file…
    expect(readFileSync(path + ".1", "utf8")).toBe("aa\nbb\n");
    // …and the oversized line lands whole, never split or truncated to the cap.
    expect(readFileSync(path, "utf8")).toBe(big + "\n");
  });

  test("an oversized line into an empty file burns no rotation slot", () => {
    // Deliberate difference from the old per-line gate: rotating first would
    // evict real history to make room for a line that overflows either way.
    const path = joinAppPath(dir, "bh.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 10,
      keep: 3,
    });
    const big = "Y".repeat(50);
    sink.appendAllSync([big]);

    expect(readFileSync(path, "utf8")).toBe(big + "\n");
    expect(rotatedFiles("bh\\.jsonl")).toEqual([]);
  });

  test("appendAll(lines) is byte-identical to looping append(line)", () => {
    // The anti-drift test: if the two forms are ever re-split into two size
    // gates, this is what fails.
    const loopPath = joinAppPath(dir, "bi.jsonl");
    const batchPath = joinAppPath(dir, "bj.jsonl");
    const opts = { maxBytes: 12, keep: 3 } as const;
    const loopSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: loopPath,
      ...opts,
    });
    const batchSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: batchPath,
      ...opts,
    });

    // 10 × 3 bytes over a 12-byte cap → two rotations.
    const lines = ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9"];
    for (const line of lines) loopSink.appendSync(line);
    batchSink.appendAllSync(lines);

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
    const path = joinAppPath(dir, "bk.jsonl");
    const sink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path,
      maxBytes: 1 << 20,
      keep: 3,
    });
    sink.appendSync("before");
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);

    sink.appendAllSync(["after-1", "after-2"]);
    expect(readFileSync(path, "utf8")).toBe("after-1\nafter-2\n");
  });
});

describe("defineFileSink / getFileSinks registry", () => {
  test("a duplicate id throws (declared exactly once)", () => {
    const id = uniqueId();
    defineFileSink({
      id,
      description: "t",
      path: joinAppPath(dir, "d.jsonl"),
    });
    expect(() =>
      defineFileSink({
        id,
        description: "t",
        path: joinAppPath(dir, "d2.jsonl"),
      }),
    ).toThrow(/already defined/);
  });

  test("getFileSinks returns a copy, not the live map", () => {
    const id = uniqueId();
    const sink = defineFileSink({
      id,
      description: "t",
      path: joinAppPath(dir, "e.jsonl"),
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
    expect(sink.path).toBe(joinAppPath(dir, "weird_name_.jsonl"));

    sink.appendSync("x");
    expect(existsSync(joinAppPath(dir, "weird_name_.jsonl"))).toBe(true);
    // A dynamic sink is covered by one family bound, not the registry.
    expect(getFileSinks().size).toBe(before);
  });
});

describe("append (async, queued per path)", () => {
  function snapshot(base: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of readdirSync(dir)
      .filter((n) => n.startsWith(base))
      .sort())
      out[n.slice(base.length)] = readFileSync(joinAppPath(dir, n), "utf8");
    return out;
  }

  test("concurrent appends land whole, in call order", async () => {
    const path = joinAppPath(dir, "q.jsonl");
    const sink = defineFileSink({ id: uniqueId(), description: "t", path });
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    await Promise.all(lines.map((l) => sink.append(l)));
    expect(readFileSync(path, "utf8")).toBe(lines.join("\n") + "\n");
  });

  test("rotates exactly as the sync writer does for the same lines", async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `L${i}-${"x".repeat(i % 7)}`,
    );
    const syncSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: joinAppPath(dir, "s.jsonl"),
      maxBytes: 37,
      keep: 2,
    });
    const asyncSink = defineFileSink({
      id: uniqueId(),
      description: "t",
      path: joinAppPath(dir, "a.jsonl"),
      maxBytes: 37,
      keep: 2,
    });
    for (const l of lines) syncSink.appendSync(l);
    // Half one by one (folding into queued drains), half as one batch.
    await Promise.all([
      ...lines.slice(0, 20).map((l) => asyncSink.append(l)),
      asyncSink.appendAll(lines.slice(20)),
    ]);
    expect(snapshot("a.jsonl")).toEqual(snapshot("s.jsonl"));
  });

  test("an empty batch creates neither the file nor its directory", async () => {
    const path = joinAppPath(dir, "nested", "e.jsonl");
    const sink = defineFileSink({ id: uniqueId(), description: "t", path });
    await sink.appendAll([]);
    expect(existsSync(joinAppPath(dir, "nested"))).toBe(false);
  });

  test("two sinks over one path share its queue", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `d${i}`);
    await Promise.all(lines.map((l) => openDynamicSink(dir, "dyn").append(l)));
    expect(readFileSync(joinAppPath(dir, "dyn.jsonl"), "utf8")).toBe(
      lines.join("\n") + "\n",
    );
  });

  test("recreates the parent dir if it disappeared under a live sink", async () => {
    const sub = joinAppPath(dir, "gone");
    const path = joinAppPath(sub, "g.jsonl");
    const sink = defineFileSink({ id: uniqueId(), description: "t", path });
    await sink.append("one");
    rmSync(sub, { recursive: true, force: true });
    await sink.append("two");
    expect(readFileSync(path, "utf8")).toBe("two\n");
  });
});

describe("append: lines still queued when the process exits", () => {
  test("are written synchronously by flushQueuedAppendsSync, in order", () => {
    const path = joinAppPath(dir, "exit.jsonl");
    const script = `
      import { defineFileSink, flushQueuedAppendsSync } from ${JSON.stringify(join(import.meta.dir, "file-sink.ts"))};
      process.once("exit", flushQueuedAppendsSync); // what file-sink's server half arms
      const sink = defineFileSink({ id: "exit-test", description: "t", path: ${JSON.stringify(path)} });
      for (let i = 0; i < 100; i++) void sink.append("line-" + i);
      process.exit(0);
    `;
    const res = Bun.spawnSync(["bun", "-e", script]);
    expect(res.exitCode).toBe(0);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toEqual(Array.from({ length: 100 }, (_, i) => `line-${i}`));
  });
});
