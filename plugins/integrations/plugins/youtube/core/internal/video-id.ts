import { z } from "zod";

/** A YouTube video id: 11 characters of URL-safe base64. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A bare YouTube video id — what every API taking one validates it with. */
export const VideoIdSchema = z
  .string()
  .regex(VIDEO_ID, "not a YouTube video id (11 URL-safe characters)");

/** Hosts that serve the same video ids as youtube.com. */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * The video id behind whatever someone pasted as a YouTube video (a
 * transcriber's Hookpad YouTube field, for one). Real TheoryTab sections hold
 * all three spellings: a bare id (`CGj85pVzRJs`), a share link
 * (`https://youtu.be/CGj85pVzRJs?si=…`) and a watch URL
 * (`https://www.youtube.com/watch?v=hTWKbfoikeg&ab_channel=NirvanaVEVO`).
 *
 * `null` when the value is none of those — there is no video to play, which the
 * caller has to show as such.
 */
export function youtubeVideoId(raw: string): string | null {
  const value = raw.trim();
  if (VIDEO_ID.test(value)) return value;
  if (!URL.canParse(value)) return null;

  const url = new URL(value);
  let candidate: string | null = null;
  if (url.hostname === "youtu.be") {
    candidate = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    candidate =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (/^\/(?:embed|shorts|live|v)\/([^/]+)/.exec(url.pathname)?.[1] ??
          null);
  }
  return candidate !== null && VIDEO_ID.test(candidate) ? candidate : null;
}

/**
 * The video's own page on youtube.com, starting at `atSeconds` (whole seconds,
 * rounded down) when given — where "open on YouTube" sends the viewer.
 */
export function youtubeWatchUrl(
  videoId: string,
  atSeconds: number | null = null,
): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  if (atSeconds !== null && atSeconds >= 1) {
    url.searchParams.set("t", `${Math.floor(atSeconds)}s`);
  }
  return url.toString();
}

/**
 * YouTube's still of the video, at one of the sizes every video has:
 * `default` 120×90, `mq` 320×180, `hq` 480×360. The 4:3 ones letterbox a 16:9
 * video, so cover-fit them into a 16:9 box.
 */
export function youtubeThumbnailUrl(
  videoId: string,
  size: "default" | "mq" | "hq" = "hq",
): string {
  const file = size === "default" ? "default" : `${size}default`;
  return `https://i.ytimg.com/vi/${videoId}/${file}.jpg`;
}
