import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { z } from "zod";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";

/**
 * The layout of one cache dir (the declared `cache/youtube-audio`, or a test's
 * temp dir): `<videoId>.<ext>` + `<videoId>.json` + `locks/<videoId>.lock`.
 * The metadata file is written LAST, so its presence (with the audio beside it)
 * is the whole definition of "cached".
 */

/** What a fetch records beside the audio. `file` is the audio's name in the dir. */
export const AudioMetaSchema = z.object({
  file: z.string(),
  format: z.string(),
  durationSec: z.number(),
  title: z.string(),
  channel: z.string(),
  ytDlpVersion: z.string(),
  fetchedAt: z.string(),
});
export type AudioMeta = z.infer<typeof AudioMetaSchema>;

export function metaPath(dir: AppPath, videoId: string): AppPath {
  return joinAppPath(dir, `${videoId}.json`);
}

export function lockPath(dir: AppPath, videoId: string): AppPath {
  return joinAppPath(dir, "locks", `${videoId}.lock`);
}

export type CacheLookup =
  { kind: "hit"; audioPath: AppPath; meta: AudioMeta } | { kind: "miss" };

/**
 * The cached audio of `videoId`, if both files are there. A hit touches both,
 * so the sweep's "last used" is the last read, not the download.
 */
export function lookupCached(
  dir: AppPath,
  videoId: string,
  now = new Date(),
): CacheLookup {
  const path = metaPath(dir, videoId);
  if (!existsSync(path)) return { kind: "miss" };
  const meta = AudioMetaSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const audioPath = joinAppPath(dir, meta.file);
  // Metadata without its audio (removed by hand): download it again.
  if (!existsSync(audioPath)) return { kind: "miss" };
  utimesSync(audioPath, now, now);
  utimesSync(path, now, now);
  return { kind: "hit", audioPath, meta };
}

/** Write the metadata temp-then-rename: a reader sees the whole file or none. */
export function writeMeta(
  dir: AppPath,
  videoId: string,
  meta: AudioMeta,
): void {
  const path = metaPath(dir, videoId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(AudioMetaSchema.parse(meta)));
  renameSync(tmp, path);
}

/** Take a video's host flock without waiting: its held descriptor, or `null` when another holds it. */
export function tryLockVideo(dir: AppPath, videoId: string): OwnedFd | null {
  const path = lockPath(dir, videoId);
  mkdirSync(dirname(path), { recursive: true });
  const lock = openOwnedFd(path, "a");
  if (flockTry(lock.fd)) return lock;
  lock.close();
  return null;
}

/** How long to wait between two tries while another process downloads the video. */
const LOCK_RETRY_MS = 500;

/**
 * Take a video's host flock, waiting for its holder. Only ever called with an
 * `ExecContext` in hand (off the backend's event loop): `flockTry` is
 * non-blocking by design, so the wait re-tries it, as `infra/deps` does.
 */
export async function waitLockVideo(
  dir: AppPath,
  videoId: string,
  onWait: () => void,
): Promise<OwnedFd> {
  const first = tryLockVideo(dir, videoId);
  if (first !== null) return first;
  onWait();
  for (;;) {
    await Bun.sleep(LOCK_RETRY_MS);
    const fd = tryLockVideo(dir, videoId);
    if (fd !== null) return fd;
  }
}

/** Release a lock taken with {@link tryLockVideo} / {@link waitLockVideo}; a second release throws. */
export function releaseLockVideo(lock: OwnedFd): void {
  lock.close();
}
