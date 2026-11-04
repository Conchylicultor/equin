import { afterAll, describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_DIR,
  KEEP_TAIL_S,
  ROTATE_AT_BYTES,
  archiveName,
  archiveSpan,
  isExpired,
  rotateLog,
} from "./rotate";

const root = mkdtempSync(join(tmpdir(), "fs-latency-rotate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400;
const NOW = Date.parse("2027-03-01T12:00:00Z") / 1000;
const tick = (t: number) =>
  JSON.stringify({
    t,
    iso: new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    pad: "x".repeat(1000),
  });

describe("archive names", () => {
  test("round-trip the instants they span", () => {
    const name = archiveName("2026-11-03T15:07:44Z", "2026-11-05T09:00:00Z");
    expect(name).toBe(
      "fs-latency-2026-11-03T15-07-44Z--2026-11-05T09-00-00Z.jsonl.gz",
    );
    expect(archiveSpan(name)).toEqual({
      firstIso: "2026-11-03T15:07:44Z",
      lastIso: "2026-11-05T09:00:00Z",
    });
    expect(archiveSpan("notes.txt")).toBeNull();
  });

  test("the calibration history is never expired; others after retention", () => {
    // After the calibration history, and past retention.
    const old = NOW - 100 * DAY;
    const iso = (t: number) => new Date(t * 1000).toISOString();
    expect(
      isExpired(
        archiveName("2026-11-03T15:07:44Z", "2026-11-05T09:00:00Z"),
        NOW,
      ),
    ).toBe(false);
    expect(isExpired(archiveName(iso(old), iso(old + DAY)), NOW)).toBe(true);
    expect(isExpired(archiveName(iso(NOW - DAY), iso(NOW)), NOW)).toBe(false);
  });
});

describe("rotateLog", () => {
  test("leaves a log under the bound alone", () => {
    const dir = join(root, "small");
    mkdirSync(dir);
    const log = join(dir, "fs-latency.jsonl");
    writeFileSync(log, tick(NOW - 10) + "\n");
    rotateLog(dir, log, NOW);
    expect(readFileSync(log, "utf8")).toBe(tick(NOW - 10) + "\n");
  });

  test("past the bound: archives everything older than the tail, keeps the tail live", () => {
    const dir = join(root, "big");
    mkdirSync(dir);
    const log = join(dir, "fs-latency.jsonl");
    const n = Math.ceil(ROTATE_AT_BYTES / 1000) + 10;
    const ts = Array.from({ length: n }, (_, i) => NOW - (n - i) * 30);
    writeFileSync(log, ts.map(tick).join("\n") + "\n");
    rotateLog(dir, log, NOW);

    const live = readFileSync(log, "utf8").trim().split("\n");
    const liveT = live.map((l) => (JSON.parse(l) as { t: number }).t);
    expect(liveT.every((t) => t >= NOW - KEEP_TAIL_S)).toBe(true);
    expect(liveT).toEqual(ts.filter((t) => t >= NOW - KEEP_TAIL_S));

    const [archive, ...more] = readdirSync(join(dir, ARCHIVE_DIR));
    expect(more).toEqual([]);
    const archived = gunzipSync(readFileSync(join(dir, ARCHIVE_DIR, archive!)))
      .toString("utf8")
      .trim()
      .split("\n");
    // Nothing lost, nothing twice.
    expect([...archived, ...live]).toEqual(ts.map(tick));
  });
});
