import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogTail, type TailRead } from "./log-tail";

const dir = mkdtempSync(join(tmpdir(), "io-health-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function line(i: number): string {
  return (
    JSON.stringify({
      t: 1_793_700_000 + i * 30,
      iso: `tick-${i}`,
      max_op_ms: 1,
      fg: { max_op: 1 },
      bg: { max_op: 1 },
      canary: [],
      load1: 1,
      daemon_cpu: {},
    }) + "\n"
  );
}

function read(r: TailRead): Extract<TailRead, { kind: "read" }> {
  if (r.kind !== "read") throw new Error("expected a read");
  return r;
}

describe("readLogTail", () => {
  test("a missing log is missing, not an error", async () => {
    expect(await readLogTail(join(dir, "nope.jsonl"), null)).toEqual({
      kind: "missing",
    });
  });

  test("resumes from its cursor and leaves a line still being written", async () => {
    const p = join(dir, "a.jsonl");
    writeFileSync(p, line(0) + line(1));
    const first = read(await readLogTail(p, null));
    expect(first.ticks.map((t) => t.iso)).toEqual(["tick-0", "tick-1"]);
    const half = line(2);
    appendFileSync(p, half.slice(0, 20));
    const second = read(await readLogTail(p, first.cursor));
    expect(second.ticks).toEqual([]);
    appendFileSync(p, half.slice(20) + line(3));
    const third = read(await readLogTail(p, second.cursor));
    expect(third.ticks.map((t) => t.iso)).toEqual(["tick-2", "tick-3"]);
  });

  test("starts at the tail, dropping the partial first line, when too much was appended", async () => {
    const p = join(dir, "b.jsonl");
    writeFileSync(p, Array.from({ length: 50 }, (_, i) => line(i)).join(""));
    const r = read(await readLogTail(p, null, line(0).length * 3 + 5));
    expect(r.ticks.map((t) => t.iso)).toEqual([
      "tick-47",
      "tick-48",
      "tick-49",
    ]);
  });

  test("a malformed line throws: a format change must be followed, not skipped", () => {
    const p = join(dir, "c.jsonl");
    writeFileSync(p, '{"t": "not a number"}\n');
    expect(readLogTail(p, null)).rejects.toThrow();
  });
});
