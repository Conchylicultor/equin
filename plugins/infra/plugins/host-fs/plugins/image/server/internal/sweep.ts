import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  existsSync,
  readdirSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A copy unused for this long is removed. */
export const SWEEP_TTL_MS = 30 * DAY_MS;
/** Past the TTL pass, the oldest copies go until the cache is this small. */
export const SWEEP_CAP_BYTES = 1024 ** 3;
/** A temp file this old belongs to a write that died. */
export const TMP_STALE_MS = HOUR_MS;

export interface CacheFile {
  name: string;
  bytes: number;
  /** A hit touches its copy (at most daily), so this is when it was last used. */
  lastUsedMs: number;
}

export type EvictReason = "stale-tmp" | "ttl" | "cap";

/**
 * Which files to remove: temp files of dead writes, every copy unused for
 * `ttlMs`, then the least recently used until the rest total `capBytes`. A
 * fresh temp file (a write under way) is kept, and counts toward the total.
 */
export function selectEvictions(
  files: readonly CacheFile[],
  args: { nowMs: number; ttlMs: number; capBytes: number },
): { name: string; reason: EvictReason; bytes: number }[] {
  const out: { name: string; reason: EvictReason; bytes: number }[] = [];
  const kept: CacheFile[] = [];
  for (const f of files) {
    const age = args.nowMs - f.lastUsedMs;
    if (f.name.startsWith(".tmp-")) {
      if (age > TMP_STALE_MS)
        out.push({ name: f.name, reason: "stale-tmp", bytes: f.bytes });
      else kept.push(f);
    } else if (age > args.ttlMs)
      out.push({ name: f.name, reason: "ttl", bytes: f.bytes });
    else kept.push(f);
  }
  let total = kept.reduce((sum, f) => sum + f.bytes, 0);
  for (const f of kept
    .filter((f) => !f.name.startsWith(".tmp-"))
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs)) {
    if (total <= args.capBytes) break;
    out.push({ name: f.name, reason: "cap", bytes: f.bytes });
    total -= f.bytes;
  }
  return out;
}

function listFiles(dir: AppPath): CacheFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const st = statSync(joinAppPath(dir, d.name));
      return { name: d.name, bytes: st.size, lastUsedMs: st.mtimeMs };
    });
}

export async function sweepResizedImages(args: {
  dir: AppPath;
  nowMs: number;
  ttlMs?: number;
  capBytes?: number;
}): Promise<{ removed: number; removedBytes: number; keptBytes: number }> {
  const files = listFiles(args.dir);
  const evictions = selectEvictions(files, {
    nowMs: args.nowMs,
    ttlMs: args.ttlMs ?? SWEEP_TTL_MS,
    capBytes: args.capBytes ?? SWEEP_CAP_BYTES,
  });
  // A copy being served while it is removed is fine: the open file outlives
  // its name, and the next request makes it again.
  for (const e of evictions) await rm(join(args.dir, e.name), { force: true });
  const removedBytes = evictions.reduce((sum, e) => sum + e.bytes, 0);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return {
    removed: evictions.length,
    removedBytes,
    keptBytes: totalBytes - removedBytes,
  };
}
