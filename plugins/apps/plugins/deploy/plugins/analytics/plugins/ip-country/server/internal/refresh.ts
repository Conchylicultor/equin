import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { stat } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defaultSnapshotPath, reloadIpCountry } from "./lookup";
import {
  SNAPSHOT_HEADER_BYTES,
  buildSnapshot,
  checkSnapshotHeader,
} from "./snapshot";

/** A snapshot younger than this is left alone: at most one download a week per machine. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The download's own bound — what makes the job's `hold: "seconds"` true. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

const monthUrl = (month: string) =>
  `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`;

/** `YYYY-MM` of `now` (UTC) and of the month before it. */
export function candidateMonths(now: Date): [string, string] {
  const fmt = (y: number, m: number) =>
    `${y}-${String(m + 1).padStart(2, "0")}`;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return [fmt(y, m), m === 0 ? fmt(y - 1, 11) : fmt(y, m - 1)];
}

/**
 * Whether the snapshot at `path` must be (re)downloaded: it is missing, older
 * than {@link SNAPSHOT_MAX_AGE_MS}, or not a snapshot of the current format
 * (so a format change heals itself on the next boot instead of failing every
 * lookup until the week runs out).
 */
export async function snapshotNeedsRefresh(
  path: string,
  now: Date,
): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (now.getTime() - info.mtimeMs >= SNAPSHOT_MAX_AGE_MS) return true;
  const file = await open(path, "r");
  try {
    const header = new Uint8Array(SNAPSHOT_HEADER_BYTES);
    const { bytesRead } = await file.read(header, 0, SNAPSHOT_HEADER_BYTES, 0);
    return (
      checkSnapshotHeader(header.subarray(0, bytesRead)).kind === "invalid"
    );
  } finally {
    await file.close();
  }
}

export type RefreshOutcome =
  { kind: "fresh" } | { kind: "downloaded"; month: string; bytes: number };

/**
 * Bring the snapshot at `path` up to date: skip when it is fresh, otherwise
 * download this month's DB-IP file (the previous month's when this one is not
 * published yet — a 404), build the snapshot, and write it atomically (temp
 * file + rename, so a concurrent reader never sees half a file).
 *
 * Every other failure throws, so the job fails visibly and retries.
 */
export async function refreshSnapshot(opts: {
  path: string;
  now: Date;
  signal: AbortSignal;
}): Promise<RefreshOutcome> {
  const { path, now, signal } = opts;
  if (!(await snapshotNeedsRefresh(path, now))) return { kind: "fresh" };

  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  ]);
  for (const month of candidateMonths(now)) {
    const url = monthUrl(month);
    const res = await fetch(url, { signal: deadline });
    if (res.status === 404) continue;
    if (!res.ok) {
      throw new Error(`ip-country: ${url} answered ${res.status}`);
    }
    const gz = new Uint8Array(await res.arrayBuffer());
    const csv = new TextDecoder().decode(Bun.gunzipSync(gz));
    const sourceMonth = Number(month.replace("-", ""));
    const bytes = await buildSnapshot(csv, sourceMonth);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${randomUUID()}`;
    try {
      await Bun.write(tmp, bytes);
      await rename(tmp, path);
    } finally {
      // After a successful rename the temp name is gone and this is a no-op;
      // after a failed write it keeps a partial file out of the cache dir.
      await rm(tmp, { force: true });
    }
    return { kind: "downloaded", month, bytes: bytes.byteLength };
  }
  throw new Error(
    `ip-country: neither ${candidateMonths(now).join(" nor ")} is published (both 404)`,
  );
}

/**
 * Weekly on Monday 03:40 UTC, and enqueued at boot when the snapshot is
 * missing or stale (see the server barrel's `onReady`).
 *
 * `perWorktree: true` is REQUIRED: a non-perWorktree cron installs only on
 * main, and a deployed release is never main. Every local worktree having the
 * cron is harmless — the freshness skip keeps it to one download a week per
 * machine, since the snapshot lives in the machine-wide cache.
 */
export const ipCountryRefreshJob = defineJob({
  name: "ip-country.refresh",
  description:
    "Downloads the IP-to-country database used to place visitors on the analytics map.",
  // seconds: one download bounded by DOWNLOAD_TIMEOUT_MS, then in-memory
  // parsing of ~90 MB of CSV that yields to the event loop between chunks.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "40 3 * * 1", perWorktree: true },
  async run({ ctx }) {
    await refreshSnapshot({
      path: defaultSnapshotPath(),
      now: new Date(),
      signal: ctx.signal,
    });
    // Also on a fresh skip: another backend on this machine may have written
    // the file this process last found missing.
    reloadIpCountry();
  },
});
