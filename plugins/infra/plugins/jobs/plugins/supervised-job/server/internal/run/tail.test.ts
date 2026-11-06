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
import { createTranscriptTail, readTranscriptEnd } from "./tail";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const dirs: string[] = [];

function scratchFile(initial = ""): AppPath {
  const dir = asAppPath(mkdtempSync(join(tmpdir(), "sg-tail-")));
  dirs.push(dir);
  const path = joinAppPath(dir, "run.log");
  writeFileSync(path, initial);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tailInto(
  path: AppPath,
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
  test("publishes complete lines and nothing else", async () => {
    const path = scratchFile("one\ntwo\n");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    expect(lines).toEqual(["one", "two"]);
  });

  test("holds back a line the child is still writing, then completes it", async () => {
    // The reason a `partial` is carried across pumps at all: a watcher fires
    // whenever bytes land, which is routinely mid-line.
    const path = scratchFile("done\nhalf");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    expect(lines).toEqual(["done"]);
    appendFileSync(path, "-a-line\n");
    await tail.pump();
    expect(lines).toEqual(["done", "half-a-line"]);
  });

  test("publishes nothing on a pump where the file did not move", async () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    await tail.pump();
    await tail.pump();
    expect(lines).toEqual(["one"]);
  });

  test("blank lines are published, not dropped", async () => {
    // The pipe-shaped loops had to drop empty pieces because every decoded
    // chunk ended in one. With the partial carried, an empty piece is content.
    const path = scratchFile("a\n\nb\n");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    expect(lines).toEqual(["a", "", "b"]);
  });

  test("a multi-byte character split across a read is reassembled", async () => {
    // The decoder is held across pumps for exactly this; a per-pump decoder
    // turns one 'é' straddling a boundary into two replacement characters.
    const path = scratchFile();
    const bytes = Buffer.from("café\n", "utf-8");
    appendFileSync(path, bytes.subarray(0, 4)); // "caf" + the first byte of é
    const { lines, tail } = tailInto(path);
    await tail.pump();
    expect(lines).toEqual([]);
    appendFileSync(path, bytes.subarray(4));
    await tail.pump();
    expect(lines).toEqual(["café"]);
  });

  test("stop() flushes a trailing line that has no newline", async () => {
    // A child killed mid-line leaves one, and it is usually the line that says
    // why the run failed.
    const path = scratchFile("first\nkilled mid-lin");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    expect(lines).toEqual(["first"]);
    await tail.stop();
    expect(lines).toEqual(["first", "killed mid-lin"]);
  });

  test("stop() drains bytes that landed since the last pump", async () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    await tail.pump();
    appendFileSync(path, "two\n");
    await tail.stop();
    expect(lines).toEqual(["one", "two"]);
  });

  test("stop() is idempotent and publishes nothing twice", async () => {
    const path = scratchFile("one\n");
    const { lines, tail } = tailInto(path);
    await tail.stop();
    await tail.stop();
    await tail.pump();
    expect(lines).toEqual(["one"]);
  });

  test("fromOffset skips what was already published", async () => {
    const path = scratchFile("skipped\nkept\n");
    const { lines, tail } = tailInto(path, { fromOffset: "skipped\n".length });
    await tail.pump();
    expect(lines).toEqual(["kept"]);
  });

  test("a missing transcript is not an error — nothing to publish yet", async () => {
    const dir = asAppPath(mkdtempSync(join(tmpdir(), "sg-tail-")));
    dirs.push(dir);
    const { lines, tail } = tailInto(joinAppPath(dir, "never-written.log"));
    await tail.pump();
    expect(lines).toEqual([]);
  });

  test("past the ceiling it records ONE truncation notice and then goes quiet", async () => {
    const path = scratchFile("aaaa\nbbbb\n");
    const { lines, tail } = tailInto(path, { ceilingBytes: 5 });
    await tail.pump();
    expect(lines[lines.length - 1]).toContain("transcript truncated");
    const afterCeiling = lines.length;
    appendFileSync(path, "cccc\ndddd\n");
    await tail.pump();
    await tail.stop();
    // Nothing after the notice — a reader told the log has stopped must not
    // then see more output arrive on it.
    expect(lines.length).toBe(afterCeiling);
  });
});

describe("readTranscriptEnd", () => {
  test("a short transcript is quoted whole, trimmed", async () => {
    expect(
      await readTranscriptEnd(scratchFile("boot\nerror: x\n\n"), 2048),
    ).toEqual({
      kind: "text",
      text: "boot\nerror: x",
    });
  });

  test("a long one is cut at a line start inside the window", async () => {
    const path = scratchFile(`${"a".repeat(100)}\nlast line\n`);
    expect(await readTranscriptEnd(path, 15)).toEqual({
      kind: "text",
      text: "last line",
    });
  });

  test("a last line longer than the window is kept, not dropped", async () => {
    const path = scratchFile(`head\nerror: ${"x".repeat(50)}\n`);
    expect(await readTranscriptEnd(path, 20)).toEqual({
      kind: "text",
      text: "x".repeat(19),
    });
  });

  test("empty and missing transcripts say so", async () => {
    expect(await readTranscriptEnd(scratchFile("  \n"), 2048)).toEqual({
      kind: "empty",
    });
    const gone = joinAppPath(
      asAppPath(tmpdir()),
      `sg-tail-gone-${process.pid}`,
    );
    expect(await readTranscriptEnd(gone, 2048)).toEqual({ kind: "missing" });
  });
});
