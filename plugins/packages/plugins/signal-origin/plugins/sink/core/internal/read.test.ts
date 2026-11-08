import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readSignalOriginLinesFrom } from "./read";

function line(buildId: string, signal: string): string {
  return JSON.stringify({
    at: "2026-08-07T15:18:25.236Z",
    event: "signal",
    buildId,
    worktree: "att-1",
    signal,
    origin: null,
  });
}

function fixtureFile(): AppPath {
  return asAppPath(
    join(mkdtempSync(join(tmpdir(), "signal-origin-")), "signal-origin.jsonl"),
  );
}

describe("readSignalOriginLinesFrom", () => {
  test("a host where nothing was ever killed reads as an empty history", async () => {
    expect(await readSignalOriginLinesFrom(fixtureFile())).toEqual([]);
  });

  test("stitches rotations back in, oldest-first", async () => {
    // A busy host rotates, and every question asked of this file is about ONE
    // past run — so a run that has slid into `.1` must still be findable.
    const file = fixtureFile();
    writeFileSync(`${file}.1`, line("older", "SIGINT") + "\n");
    writeFileSync(file, line("newer", "SIGTERM") + "\n");

    expect(
      (await readSignalOriginLinesFrom(file)).map((r) => r.buildId),
    ).toEqual(["older", "newer"]);
  });

  test("skips a torn tail line instead of throwing", async () => {
    // The normal case for this file: its writer is a process in the middle of
    // dying, so the last append can be half-flushed.
    const file = fixtureFile();
    writeFileSync(file, line("b1", "SIGTERM") + "\n" + '{"event":"sig');

    const records = await readSignalOriginLinesFrom(file);
    expect(records).toHaveLength(1);
    expect(records[0]?.buildId).toBe("b1");
  });
});
