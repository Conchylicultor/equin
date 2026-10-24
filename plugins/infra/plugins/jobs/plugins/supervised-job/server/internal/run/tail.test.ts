/**
 * The tailer against real files.
 *
 * `createTranscriptTail` takes its file by path and its sink by callback, so
 * unlike the supervisor around it there is nothing here to point at a fixture —
 * a temp directory IS the fixture. What is worth asserting is everything the
 * pipe-shaped loops it replaces never had to think about: a line arriving in
 * two pieces, a multi-byte character split across a read, a final line with no
 * newline, and the ceiling.
 *
 * Run: `./equin test plugins/infra/plugins/jobs/plugins/supervised-job`
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptTail } from "./tail";

const dirs: string[] = [];

function scratchFile(initial = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "sg-tail-"));
  dirs.push(dir);
  const path = join(dir, "run.log");
  writeFileSync(path, initial);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tailInto(
  path: string,
  opts?: { fromOffset?: number; ceilingBytes?: number },
): { lines: string[]; tail: ReturnType<typeof createTranscriptTail> } {
  const lines: string[] = [];
  const tail = createTranscriptTail({
    path,
    fromOffset: opts?.fromOffset ?? 0,
    ceilingBytes: opts?.ceilingBytes,
    publish: (batch) => lines.push(...batch),
  });
  return { lines, tail };
}

describe("createTranscriptTail", () => {
  test("publishes complete lines and nothing else", () => {
    const path = scratchFile("one\ntwo\n");
    const { lines, tail } = tailInto(path);
    tail.pump();
    expect(lines).toEqual(["one", "two"]);
  });

  test("holds back a line the child is still writing, then completes it", () => {
    // The reason a `partial` is carried across pumps at all: a watcher fires
    // whenever bytes land, which is routinely mid-line.
    const path = scratchFile("done\nhalf");
    const { lines, tail } = tailInto(path);
    tail.pump();
    expect(lines).toEqual(["done"]);
    appendFileSync(path, "-a-line\n");
    tail.pump();
    expect(lines).toEqual(["done", "half-a-line"]);
  });

  test("publishes nothing on a pump where the file did not move", () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    tail.pump();
    tail.pump();
    tail.pump();
    expect(lines).toEqual(["one"]);
  });

  test("blank lines are published, not dropped", () => {
    // The pipe-shaped loops had to drop empty pieces because every decoded
    // chunk ended in one. With the partial carried, an empty piece is content.
    const path = scratchFile("a\n\nb\n");
    const { lines, tail } = tailInto(path);
    tail.pump();
    expect(lines).toEqual(["a", "", "b"]);
  });

  test("a multi-byte character split across a read is reassembled", () => {
    // The decoder is held across pumps for exactly this; a per-pump decoder
    // turns one 'é' straddling a boundary into two replacement characters.
    const path = scratchFile();
    const bytes = Buffer.from("café\n", "utf-8");
    appendFileSync(path, bytes.subarray(0, 4)); // "caf" + the first byte of é
    const { lines, tail } = tailInto(path);
    tail.pump();
    expect(lines).toEqual([]);
    appendFileSync(path, bytes.subarray(4));
    tail.pump();
    expect(lines).toEqual(["café"]);
  });

  test("stop() flushes a trailing line that has no newline", () => {
    // A child killed mid-line leaves one, and it is usually the line that says
    // why the run failed.
    const path = scratchFile("first\nkilled mid-lin");
    const { lines, tail } = tailInto(path);
    tail.pump();
    expect(lines).toEqual(["first"]);
    tail.stop();
    expect(lines).toEqual(["first", "killed mid-lin"]);
  });

  test("stop() drains bytes that landed since the last pump", () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    tail.pump();
    appendFileSync(path, "two\n");
    tail.stop();
    expect(lines).toEqual(["one", "two"]);
  });

  test("stop() is idempotent and publishes nothing twice", () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    tail.stop();
    tail.stop();
    tail.pump();
    expect(lines).toEqual(["one"]);
  });

  test("fromOffset skips what was already published", () => {
    const path = scratchFile("skipped\nkept\n");
    const { lines, tail } = tailInto(path, { fromOffset: "skipped\n".length });
    tail.pump();
    expect(lines).toEqual(["kept"]);
  });

  test("a missing transcript is not an error — nothing to publish yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-tail-"));
    dirs.push(dir);
    const { lines, tail } = tailInto(join(dir, "never-written.log"));
    expect(() => tail.pump()).not.toThrow();
    expect(lines).toEqual([]);
  });

  test("past the ceiling it records ONE truncation notice and then goes quiet", () => {
    const path = scratchFile("aaaa\nbbbb\n");
    const { lines, tail } = tailInto(path, { ceilingBytes: 5 });
    tail.pump();
    expect(lines[lines.length - 1]).toContain("transcript truncated");
    const afterCeiling = lines.length;
    appendFileSync(path, "cccc\ndddd\n");
    tail.pump();
    tail.stop();
    // Nothing after the notice — a reader told the log has stopped must not
    // then see more output arrive on it.
    expect(lines.length).toBe(afterCeiling);
  });
});
