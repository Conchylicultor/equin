import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lookupCached,
  releaseLockVideo,
  tryLockVideo,
  writeMeta,
} from "./cache";
import {
  listEntries,
  selectEvictions,
  sweepYouTubeAudio,
  type CacheEntry,
} from "./sweep";

const NOW = new Date("2026-09-30T12:00:00.000Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const MB = 1_000_000;

function entry(
  videoId: string,
  daysAgo: number,
  mb: number,
  extra: Partial<CacheEntry> = {},
): CacheEntry {
  return {
    videoId,
    files: [],
    bytes: mb * MB,
    lastUsedMs: NOW - daysAgo * DAY,
    complete: true,
    locked: false,
    ...extra,
  };
}

describe("selectEvictions", () => {
  const args = { nowMs: NOW, ttlMs: 30 * DAY, capBytes: 10 * MB };

  test("removes what is past the TTL, keeps the rest under the cap", () => {
    expect(
      selectEvictions(
        [entry("a", 31, 1), entry("b", 29, 1), entry("c", 1, 1)],
        args,
      ),
    ).toEqual([{ videoId: "a", reason: "ttl" }]);
  });

  test("past the cap, removes least recently used first until it fits", () => {
    const evictions = selectEvictions(
      [
        entry("new", 1, 4),
        entry("old", 20, 4),
        entry("mid", 10, 4),
        entry("newest", 0, 1),
      ],
      args,
    );
    // 13 MB: dropping `old` (4) leaves 9 ≤ 10.
    expect(evictions).toEqual([{ videoId: "old", reason: "cap" }]);
  });

  test("the TTL pass counts toward the cap", () => {
    const evictions = selectEvictions(
      [entry("stale", 40, 8), entry("a", 5, 4), entry("b", 2, 4)],
      args,
    );
    expect(evictions).toEqual([{ videoId: "stale", reason: "ttl" }]);
  });

  test("never a locked entry, but it counts toward the total", () => {
    const evictions = selectEvictions(
      [
        entry("busy", 60, 8, { locked: true }),
        entry("a", 5, 2),
        entry("b", 2, 2),
      ],
      args,
    );
    // 12 MB with `busy` unremovable: `a` (the older) goes, leaving 10.
    expect(evictions).toEqual([{ videoId: "a", reason: "cap" }]);
  });

  test("an unlocked incomplete entry (a killed download's leftovers) goes at once", () => {
    expect(
      selectEvictions(
        [
          entry("half", 0, 1, { complete: false }),
          entry("busy", 0, 1, { complete: false, locked: true }),
        ],
        args,
      ),
    ).toEqual([{ videoId: "half", reason: "incomplete" }]);
  });
});

describe("sweepYouTubeAudio on a directory", () => {
  let dir: AppPath;
  beforeEach(() => {
    dir = asAppPath(mkdtempSync(join(tmpdir(), "youtube-audio-sweep-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function cache(
    videoId: string,
    daysAgo: number,
    bytes: number,
  ): Promise<void> {
    writeFileSync(join(dir, `${videoId}.webm`), Buffer.alloc(bytes));
    await writeMeta(dir, videoId, {
      file: `${videoId}.webm`,
      format: "webm",
      durationSec: 200,
      title: videoId,
      channel: "c",
      ytDlpVersion: "2026.08.19",
      fetchedAt: new Date(NOW).toISOString(),
    });
    const at = new Date(NOW - daysAgo * DAY);
    utimesSync(join(dir, `${videoId}.webm`), at, at);
    utimesSync(join(dir, `${videoId}.json`), at, at);
  }

  test("groups a video's files into one entry and ignores the rest", async () => {
    await cache("AAAAAAAAAAA", 1, 100);
    writeFileSync(join(dir, ".tmp-BBBBBBBBBBB-4242.webm.part"), "x");
    writeFileSync(join(dir, "notes.txt"), "not ours");
    const entries = (await listEntries(dir)).sort((a, b) =>
      a.videoId.localeCompare(b.videoId),
    );
    expect(entries.map((e) => [e.videoId, e.files.sort(), e.complete])).toEqual(
      [
        ["AAAAAAAAAAA", ["AAAAAAAAAAA.json", "AAAAAAAAAAA.webm"], true],
        ["BBBBBBBBBBB", [".tmp-BBBBBBBBBBB-4242.webm.part"], false],
      ],
    );
  });

  test("evicts by TTL, then oldest first to the cap, skipping a held lock", async () => {
    await cache("stale000000", 45, 1000);
    await cache("old00000000", 20, 1000);
    await cache("mid00000000", 10, 1000);
    await cache("new00000000", 1, 1000);
    await cache("busy0000000", 50, 1000);
    writeFileSync(join(dir, ".tmp-dead0000000-99.webm.part"), "x");

    const held = await tryLockVideo(dir, "busy0000000");
    if (held === null) throw new Error("could not take the test's lock");
    try {
      const report = await sweepYouTubeAudio({
        dir,
        nowMs: NOW,
        ttlMs: 30 * DAY,
        capBytes: 2500,
      });
      expect(report.removed.map((r) => [r.videoId, r.reason]).sort()).toEqual([
        ["dead0000000", "incomplete"],
        ["mid00000000", "cap"],
        ["old00000000", "cap"],
        ["stale000000", "ttl"],
      ]);
    } finally {
      releaseLockVideo(held);
    }
    const left = readdirSync(dir)
      .filter((f) => f !== "locks")
      .sort();
    expect(left).toEqual([
      "busy0000000.json",
      "busy0000000.webm",
      "new00000000.json",
      "new00000000.webm",
    ]);
  });

  test("a hit touches the files, so a read video is not the oldest", async () => {
    await cache("read0000000", 25, 1000);
    await cache("unread00000", 20, 1000);
    const hit = await lookupCached(dir, "read0000000", new Date(NOW));
    expect(hit.kind).toBe("hit");
    await sweepYouTubeAudio({ dir, nowMs: NOW, capBytes: 1500 });
    expect(existsSync(join(dir, "read0000000.webm"))).toBe(true);
    expect(existsSync(join(dir, "unread00000.webm"))).toBe(false);
  });
});
