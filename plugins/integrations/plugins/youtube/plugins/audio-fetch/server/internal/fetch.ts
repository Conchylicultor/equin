import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { basename, dirname } from "node:path";
import { z } from "zod";
import { ensureDep } from "@plugins/infra/plugins/deps/deps";
import { runPython } from "@plugins/infra/plugins/deps/plugins/python/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import { VideoIdSchema } from "@plugins/integrations/plugins/youtube/core";
import { youtubeAudioCacheDir } from "../../data-dirs";
import {
  lookupCached,
  releaseLockVideo,
  waitLockVideo,
  writeMeta,
  type AudioMeta,
} from "./cache";
import { ytDlpDep } from "@plugins/integrations/plugins/youtube/deps";

/** One video's audio, as downloaded: the stream YouTube served, untouched. */
export interface YouTubeAudio {
  /** Absolute path of the audio file, `<cache>/<videoId>.<ext>`. */
  path: string;
  /** The container's extension, e.g. `webm` (opus) or `m4a` (aac). */
  format: string;
  durationSec: number;
  title: string;
  channel: string;
  /** The yt-dlp release that downloaded it. */
  ytDlpVersion: string;
}

/**
 * YouTube will not serve this video to anyone: unavailable, private, removed,
 * age-gated. Retrying cannot help, so it is non-retryable; the message is
 * yt-dlp's own.
 */
export class YouTubeAudioUnavailableError extends NonRetryableError {
  constructor(
    readonly videoId: string,
    readonly reason: string,
  ) {
    super(`YouTube video ${videoId} is unavailable: ${reason}`);
    this.name = "YouTubeAudioUnavailableError";
  }
}

/**
 * This video's download failed in a way that may clear later: YouTube still
 * refused its audio stream (HTTP 403) after re-extracting it, or another
 * download error on this video (a broken format). A failure of the video, not
 * of the machine (that is `YouTubeAccessError`). Retryable.
 */
export class YouTubeAudioDownloadError extends Error {
  constructor(
    readonly videoId: string,
    /** One readable line. */
    readonly reason: string,
    /** yt-dlp's own message. */
    readonly detail: string = reason,
  ) {
    super(`Downloading YouTube video ${videoId} failed: ${reason}`);
    this.name = "YouTubeAudioDownloadError";
  }
}

/**
 * This machine cannot get audio from YouTube right now, whatever the video:
 * a bot check or rate limit on its IP (`blocked`), or YouTube cannot be
 * reached (`network`). It clears, so it is retryable; it is NOT
 * `isYouTubeAudioError`, since moving on to another video would fail alike.
 */
export class YouTubeAccessError extends Error {
  constructor(
    readonly videoId: string,
    readonly kind: "blocked" | "network",
    /** One readable line. */
    readonly reason: string,
    /** yt-dlp's own message. */
    readonly detail: string,
  ) {
    super(
      `YouTube audio for ${videoId} is out of reach from this machine: ${reason}`,
    );
    this.name = "YouTubeAccessError";
  }
}

/**
 * The failure is THIS video's audio — YouTube will not serve it, or its
 * download failed — rather than the machine's (a missing dependency, no
 * network, a bot check, a crash). A caller choosing between videos moves on
 * to the next one on such a failure, and fails on any other.
 */
export function isYouTubeAudioError(
  err: unknown,
): err is YouTubeAudioUnavailableError | YouTubeAudioDownloadError {
  return (
    err instanceof YouTubeAudioUnavailableError ||
    err instanceof YouTubeAudioDownloadError
  );
}

/**
 * `youtube_audio.fetch`'s one stdout document: the audio, or a failure yt-dlp
 * reported, classified by the module (a crash is a non-zero exit instead).
 */
export const FetchOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    file: z.string(),
    format: z.string(),
    durationSec: z.number(),
    title: z.string(),
    channel: z.string(),
    ytDlpVersion: z.string(),
    attempts: z.number().int().positive(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.enum(["unavailable", "refused", "blocked", "network"]),
    message: z.string(),
    detail: z.string(),
    attempts: z.number().int().positive(),
  }),
]);

type FetchFailure = Extract<z.infer<typeof FetchOutputSchema>, { ok: false }>;

/** The typed error a classified failure of the fetch module is thrown as. */
export function failureError(
  videoId: string,
  failure: FetchFailure,
):
  | YouTubeAudioUnavailableError
  | YouTubeAudioDownloadError
  | YouTubeAccessError {
  switch (failure.kind) {
    case "unavailable":
      return new YouTubeAudioUnavailableError(videoId, failure.message);
    case "refused":
      return new YouTubeAudioDownloadError(
        videoId,
        failure.message,
        failure.detail,
      );
    case "blocked":
    case "network":
      return new YouTubeAccessError(
        videoId,
        failure.kind,
        failure.message,
        failure.detail,
      );
  }
}

/** A download is a few MB; ten minutes covers a slow link and a long video. */
const FETCH_TIMEOUT_MS = 10 * 60_000;

export interface FetchOptions {
  /** Progress lines: the dep install's and yt-dlp's. */
  log?: (line: string) => void;
  /** Test seam: the cache dir. Default: the declared `cache/youtube-audio`. */
  dir?: AppPath;
}

function toAudio(path: string, meta: AudioMeta): YouTubeAudio {
  return {
    path,
    format: meta.format,
    durationSec: meta.durationSec,
    title: meta.title,
    channel: meta.channel,
    ytDlpVersion: meta.ytDlpVersion,
  };
}

/**
 * The audio of one YouTube video, downloaded into the host-wide cache on first
 * use.
 *
 * - **Hit** (the metadata and the audio are both there): touches them for the
 *   sweep and returns — no Python, no lock.
 * - **Miss**: takes the video's host flock (waiting for another process
 *   downloading it), re-checks, makes sure the `youtube-audio` dependency is
 *   installed, and runs `youtube_audio.fetch`. The audio lands under its final
 *   name by rename; the metadata is written after it, atomically.
 *
 * Demands an `ExecContext`: it can install a dependency and runs a download,
 * so it never runs on a backend's event loop.
 *
 * @throws YouTubeAudioUnavailableError when YouTube will not serve the video.
 * @throws YouTubeAudioDownloadError when this video's download failed in a way
 *   that may clear (`isYouTubeAudioError` answers both).
 * @throws YouTubeAccessError when this machine cannot get audio from YouTube
 *   (bot check, rate limit, no network) — not this video's failure.
 */
export async function fetchYouTubeAudio(
  videoId: string,
  exec: ExecContext,
  opts: FetchOptions = {},
): Promise<YouTubeAudio> {
  const id = VideoIdSchema.parse(videoId);
  const dir = opts.dir ?? youtubeAudioCacheDir.ensure();
  const say = opts.log ?? (() => {});

  const cached = await lookupCached(dir, id);
  if (cached.kind === "hit") return toAudio(cached.audioPath, cached.meta);

  const fd = await waitLockVideo(dir, id, () =>
    say(`another process is downloading ${id}; waiting for it`),
  );
  try {
    const again = await lookupCached(dir, id);
    if (again.kind === "hit") return toAudio(again.audioPath, again.meta);

    const ready = await ensureDep(ytDlpDep, exec, { log: say });
    const out = await runPython(ready, {
      module: "youtube_audio.fetch",
      input: { videoId: id, outDir: dir, bunPath: process.execPath },
      output: FetchOutputSchema,
      timeoutMs: FETCH_TIMEOUT_MS,
      log: say,
    });
    if (!out.ok) throw failureError(id, out);
    if (
      dirname(out.file) !== dir ||
      basename(out.file) !== `${id}.${out.format}`
    ) {
      throw new Error(
        `youtube_audio.fetch wrote ${out.file}, expected ${dir}/${id}.${out.format}`,
      );
    }
    const meta: AudioMeta = {
      file: basename(out.file),
      format: out.format,
      durationSec: out.durationSec,
      title: out.title,
      channel: out.channel,
      ytDlpVersion: out.ytDlpVersion,
      fetchedAt: new Date().toISOString(),
    };
    await writeMeta(dir, id, meta);
    return toAudio(out.file, meta);
  } finally {
    releaseLockVideo(fd);
  }
}
