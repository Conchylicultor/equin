import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SentinelVitalsRecord } from "../../core";
import {
  readSentinelVitals,
  vitalsFilePath,
  writeSentinelVitals,
} from "./vitals-file";

const dirs: string[] = [];
function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-vitals-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const RECORD: SentinelVitalsRecord = {
  pid: 4242,
  wall: 1_789_700_000_000,
  cadenceMs: 5_000,
  signals: {
    loadRatio: { value: 0.26, limit: 1.5 },
    decompressionsPerSec: { value: null, limit: 50_000 },
    locksWaiting: { value: 0, limit: 5 },
    blkReadDeltaMs: { value: 40, limit: 2_000 },
    slowBackends: { value: 0, limit: 2 },
  },
  elevated: [],
  tripped: false,
  context: {
    freeMemMb: 9_600,
    inFlightBuilds: 1,
    runningBackends: 7,
    disk: { totalBytes: 1_000, freeBytes: 600, fillBytesPerSec: null },
  },
};

describe("sentinel vitals file", () => {
  test("a written reading reads back whole, leaving no temp file", () => {
    // A directory that does not exist yet: the writer creates it.
    const dir = join(newDir(), "sentinel");
    writeSentinelVitals(dir, RECORD);
    expect(readSentinelVitals(dir)).toEqual({
      kind: "recorded",
      vitals: RECORD,
    });
    expect(readdirSync(dir)).toEqual(["vitals.json"]);
  });

  test("no file reads as none", () => {
    expect(readSentinelVitals(newDir())).toEqual({ kind: "none" });
  });

  test("garbage and a wrong shape read as unreadable, with the reason", () => {
    const dir = newDir();
    writeFileSync(vitalsFilePath(dir), "{not json");
    const garbage = readSentinelVitals(dir);
    expect(garbage.kind).toBe("unreadable");
    expect(garbage.kind === "unreadable" && garbage.reason).toContain(
      "not JSON",
    );

    writeFileSync(
      vitalsFilePath(dir),
      JSON.stringify({ ...RECORD, elevated: ["cpuTemperature"] }),
    );
    expect(readSentinelVitals(dir).kind).toBe("unreadable");
  });
});
