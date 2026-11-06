import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { exists, readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { metaPath, releaseLockVideo, tryLockVideo } from "./cache";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Audio unused for this long is removed. */
export const SWEEP_TTL_MS = 30 * DAY_MS;
/** Past the TTL pass, the oldest audio goes until the cache is this small. */
export const SWEEP_CAP_BYTES = 2 * 1024 ** 3;

/** One video's files in the cache: its audio, metadata and any temp file. */
export interface CacheEntry {
  videoId: string;
  files: string[];
  bytes: number;
  /** The newest mtime of its files: a hit touches them. */
  lastUsedMs: number;
  /** Whether its metadata is there (written last, so: whether it is cached). */
  complete: boolean;
  /** Whether a download holds its lock right now. */
  locked: boolean;
}

export type EvictReason = "incomplete" | "ttl" | "cap";

export interface Eviction {
  videoId: string;
  reason: EvictReason;
}

/**
 * Which entries to remove, in order. Never a locked one (a download is running
 * there). Unlocked and incomplete: the leftovers of a killed download, removed
 * at once. Then every entry unused for `ttlMs`. Then the least recently used
 * until what is left totals at most `capBytes` (locked entries count toward the
 * total; they just cannot be removed).
 */
export function selectEvictions(
  entries: readonly CacheEntry[],
  args: { nowMs: number; ttlMs: number; capBytes: number },
): Eviction[] {
  const evictions: Eviction[] = [];
  const kept: CacheEntry[] = [];
  for (const entry of entries) {
    if (entry.locked) kept.push(entry);
    else if (!entry.complete)
      evictions.push({ videoId: entry.videoId, reason: "incomplete" });
    else if (args.nowMs - entry.lastUsedMs > args.ttlMs)
      evictions.push({ videoId: entry.videoId, reason: "ttl" });
    else kept.push(entry);
  }
  let total = kept.reduce((sum, e) => sum + e.bytes, 0);
  const oldestFirst = kept
    .filter((e) => !e.locked)
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
  for (const entry of oldestFirst) {
    if (total <= args.capBytes) break;
    evictions.push({ videoId: entry.videoId, reason: "cap" });
    total -= entry.bytes;
  }
  return evictions;
}

/** `<videoId>.<ext>` / `<videoId>.json` / `.tmp-<videoId>-<pid>.<ext>[.part|.ytdl]` (yt-dlp's temp) / a metadata temp. */
const ENTRY_FILE =
  /^(?:\.tmp-)?([A-Za-z0-9_-]{11})(?:-\d+)?\.[A-Za-z0-9]+(?:\.(?:part|ytdl|tmp-\d+))?$/;

/**
 * The cache's entries, one per video, read from the top-level files (the
 * `locks/` dir is not an entry). Each entry's lock is probed: taken for the
 * instant of the test and released.
 */
export async function listEntries(dir: AppPath): Promise<CacheEntry[]> {
  if (!(await exists(dir))) return [];
  const byId = new Map<string, CacheEntry>();
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    const videoId = ENTRY_FILE.exec(dirent.name)?.[1];
    if (videoId === undefined) continue;
    const st = await stat(joinAppPath(dir, dirent.name));
    const entry = byId.get(videoId) ?? {
      videoId,
      files: [],
      bytes: 0,
      lastUsedMs: 0,
      complete: await exists(metaPath(dir, videoId)),
      locked: false,
    };
    entry.files.push(dirent.name);
    entry.bytes += st.size;
    entry.lastUsedMs = Math.max(entry.lastUsedMs, st.mtimeMs);
    byId.set(videoId, entry);
  }
  for (const entry of byId.values()) {
    const fd = await tryLockVideo(dir, entry.videoId);
    if (fd === null) entry.locked = true;
    else releaseLockVideo(fd);
  }
  return [...byId.values()];
}

export interface SweepReport {
  removed: (Eviction & { bytes: number })[];
  /** Selected, but a download took the lock before the removal could. */
  skippedLocked: string[];
  keptBytes: number;
}

/**
 * Remove what {@link selectEvictions} picks, each under its video's lock, so a
 * download that starts meanwhile is never cut from under.
 */
export async function sweepYouTubeAudio(args: {
  dir: AppPath;
  nowMs: number;
  ttlMs?: number;
  capBytes?: number;
}): Promise<SweepReport> {
  const entries = await listEntries(args.dir);
  const evictions = selectEvictions(entries, {
    nowMs: args.nowMs,
    ttlMs: args.ttlMs ?? SWEEP_TTL_MS,
    capBytes: args.capBytes ?? SWEEP_CAP_BYTES,
  });
  const byId = new Map(entries.map((e) => [e.videoId, e]));
  const report: SweepReport = { removed: [], skippedLocked: [], keptBytes: 0 };
  const removedIds = new Set<string>();
  for (const eviction of evictions) {
    const entry = byId.get(eviction.videoId);
    if (entry === undefined) throw new Error(`no entry ${eviction.videoId}`);
    const fd = await tryLockVideo(args.dir, entry.videoId);
    if (fd === null) {
      report.skippedLocked.push(entry.videoId);
      continue;
    }
    try {
      // The metadata first: without it the video reads as not cached.
      const ordered = [
        ...entry.files.filter((f) => f === `${entry.videoId}.json`),
        ...entry.files.filter((f) => f !== `${entry.videoId}.json`),
      ];
      for (const file of ordered)
        await rm(joinAppPath(args.dir, file), { force: true });
    } finally {
      releaseLockVideo(fd);
    }
    removedIds.add(entry.videoId);
    report.removed.push({ ...eviction, bytes: entry.bytes });
  }
  report.keptBytes = entries
    .filter((e) => !removedIds.has(e.videoId))
    .reduce((sum, e) => sum + e.bytes, 0);
  return report;
}
