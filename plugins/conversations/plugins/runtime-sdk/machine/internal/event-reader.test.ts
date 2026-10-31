import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentEvents, readEventsAfter } from "./event-reader";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdk-events-"));
  path = join(dir, "events.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (seq: number) =>
  JSON.stringify({ seq, t: seq, kind: "sdk", payload: { type: "x" } }) + "\n";
const append = (file: string, ...seqs: number[]) =>
  appendFileSync(file, seqs.map(line).join(""));
/** What the sink does at its cap: shift every generation up by one. */
function rotate() {
  for (const n of [2, 1]) {
    try {
      renameSync(`${path}.${n}`, `${path}.${n + 1}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  renameSync(path, `${path}.1`);
}
const seqs = (r: ReturnType<typeof readAgentEvents>) =>
  r.events.map((e) => e.seq);

describe("readAgentEvents", () => {
  test("no file yet: nothing, and no position", () => {
    expect(readAgentEvents(path, null)).toEqual({ events: [], position: null });
  });

  test("reads on from where it stopped", () => {
    append(path, 1, 2);
    const first = readAgentEvents(path, null);
    expect(seqs(first)).toEqual([1, 2]);
    append(path, 3);
    expect(seqs(readAgentEvents(path, first.position))).toEqual([3]);
  });

  test("leaves a line still being written for the next read", () => {
    append(path, 1);
    appendFileSync(path, '{"seq":2,"t":2,"ki');
    const first = readAgentEvents(path, null);
    expect(seqs(first)).toEqual([1]);
    appendFileSync(path, 'nd":"sdk","payload":{}}\n');
    expect(seqs(readAgentEvents(path, first.position))).toEqual([2]);
  });

  test("follows a rotation: the rest of the old file, then the new one", () => {
    append(path, 1, 2);
    const first = readAgentEvents(path, null);
    append(path, 3);
    rotate();
    append(path, 4);
    expect(seqs(readAgentEvents(path, first.position))).toEqual([3, 4]);
  });

  test("a fresh reader reads every generation oldest first", () => {
    append(path, 1);
    rotate();
    append(path, 2);
    rotate();
    append(path, 3);
    expect(seqs(readAgentEvents(path, null))).toEqual([1, 2, 3]);
  });

  test("a position rotated past every kept generation rereads what is left", () => {
    append(path, 1);
    const first = readAgentEvents(path, null);
    for (const s of [2, 3, 4, 5]) {
      rotate();
      append(path, s);
    }
    // Generation 1 (its inode) is gone: the reducer's cursor skips the
    // re-read lines and reports the jump.
    expect(seqs(readAgentEvents(path, first.position))).toEqual([2, 3, 4, 5]);
  });

  test("an unreadable line throws, naming the file", () => {
    writeFileSync(path, "not json\n");
    expect(() => readAgentEvents(path, null)).toThrow(/events\.jsonl/);
  });
});

describe("readEventsAfter", () => {
  test("a stored position reads on from the line after its cursor", () => {
    append(path, 1, 2);
    const stored = readAgentEvents(path, null).position;
    append(path, 3, 4);
    expect(seqs(readEventsAfter(path, 2, stored))).toEqual([3, 4]);
  });

  test("nothing appended since: nothing to read", () => {
    append(path, 1, 2);
    const stored = readAgentEvents(path, null).position;
    expect(seqs(readEventsAfter(path, 2, stored))).toEqual([]);
  });

  test("a position into other bytes (its first line is past the cursor): the whole family", () => {
    append(path, 1, 2, 3);
    const end = readAgentEvents(path, null).position!;
    append(path, 4);
    // The cursor only reached 1, yet the position says 3: it is not this cursor's.
    expect(seqs(readEventsAfter(path, 1, end))).toEqual([1, 2, 3, 4]);
  });

  test("a position past the end of the file that has its inode: the whole family", () => {
    append(path, 1);
    const ino = statSync(path).ino;
    // Same inode, rewritten shorter than the stored offset (an inode reused).
    expect(seqs(readEventsAfter(path, 0, { ino, offset: 10_000 }))).toEqual([
      1,
    ]);
  });

  test("a position rotated past every kept generation reads what is left once", () => {
    append(path, 1);
    const stored = readAgentEvents(path, null).position;
    for (const seq of [2, 3, 4]) {
      rotate();
      append(path, seq);
    }
    expect(seqs(readEventsAfter(path, 1, stored))).toEqual([2, 3, 4]);
  });
});
