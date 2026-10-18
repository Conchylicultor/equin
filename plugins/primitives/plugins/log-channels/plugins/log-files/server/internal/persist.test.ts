import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listChannelsInDir, readTail } from "./persist";

// Hermetic: everything runs in an isolated temp dir. We never touch the real
// ~/.singularity logs. The WRITE/rotation path moved to file-sink (its own tests
// cover rotation/keep/dup-id), so here we only exercise the READ path — seeding
// fixture files directly on disk with the `{t,stream,line}` JSONL envelope.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "log-read-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envelope(n: number): string {
  return JSON.stringify({ t: n, stream: "stdout", line: `line-${n}` });
}

function seed(channel: string, lines: string[]): void {
  writeFileSync(join(dir, channel), lines.join("\n") + "\n");
}

describe("listChannelsInDir", () => {
  test("excludes rotated files (`channel.jsonl.N`)", () => {
    // A live file plus two rotations on disk — only the live channel is listed.
    seed("channel.jsonl", [envelope(1)]);
    seed("channel.jsonl.1", [envelope(0)]);
    seed("channel.jsonl.2", [envelope(-1)]);
    expect(listChannelsInDir(dir)).toEqual(["channel"]);
  });

  test("returns [] for a missing dir (ENOENT), not an error", () => {
    expect(listChannelsInDir(join(dir, "does-not-exist"))).toEqual([]);
  });
});

describe("readTail", () => {
  test("returns the last N entries of the live file", () => {
    seed(
      "channel.jsonl",
      Array.from({ length: 10 }, (_, i) => envelope(i)),
    );
    const entries = readTail(join(dir, "channel.jsonl"), 3);
    expect(entries?.map((e) => e.line)).toEqual(["line-7", "line-8", "line-9"]);
  });

  test("tolerates a corrupt/partial trailing line", () => {
    writeFileSync(
      join(dir, "channel.jsonl"),
      envelope(1) + "\n" + envelope(2) + "\n" + "{not-json" + "\n",
    );
    const entries = readTail(join(dir, "channel.jsonl"), 10);
    expect(entries?.map((e) => e.line)).toEqual(["line-1", "line-2"]);
  });

  test("missing file returns null (ENOENT), not an empty success", () => {
    expect(readTail(join(dir, "does-not-exist.jsonl"), 5)).toBeNull();
  });
});
