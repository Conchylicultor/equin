// The video encoder: rendered frames on stdin (JPEG), out as H.264 (yuv420p)
// + AAC 192k in an MP4 with faststart — and, for a film that wants one, its
// light web version transcoded from it (`webEncodeArgs`).
//
// Two shapes, one codec setting (`videoCodecArgs`):
//  - serial: one encoder takes every frame and the mixed audio WAV;
//  - parallel: each chunk's encoder takes its frames (video only) into its own
//    MP4 — an encode of its own, so it opens on an IDR frame and no frame
//    references across a chunk boundary (closed GOPs by construction) — then
//    `concatArgs` joins the chunks with the concat demuxer (-c:v copy, the
//    bytes untouched) and muxes the audio once over the whole film.
//
// Every write is `-n`: a film is a version, and runFilm refuses an existing
// output first; this makes the encoder itself unable to replace one.

export interface Encoder {
  /** Write one frame (all frames the same format and size). Backpressure-safe. */
  frame(bytes: Uint8Array): Promise<void>;
  /** Close the stream, wait for ffmpeg, resolve with the output path. */
  finish(): Promise<string>;
  /** Kill ffmpeg (a failed render); its partial output is the caller's to delete. */
  abort(): void;
}

export interface VideoOptions {
  ffmpeg: string;
  out: string;
  fps: number;
  width: number;
  height: number;
  /** Faster preset, higher CRF. */
  preview: boolean;
}

export interface EncoderOptions extends VideoOptions {
  audio: string;
  duration: number;
}

/** JPEG frames on stdin at `fps`. */
const frameInput = (fps: number): string[] => [
  "-f",
  "image2pipe",
  "-framerate",
  String(fps),
  "-c:v",
  "mjpeg",
  "-i",
  "pipe:0",
];

/** Scale + H.264 settings — the same for the serial encode and every chunk, so chunks concat. */
const videoCodecArgs = (o: VideoOptions): string[] => [
  "-vf",
  `scale=${o.width}:${o.height}:flags=lanczos,format=yuv420p`,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  o.preview ? "24" : "16",
  "-preset",
  o.preview ? "veryfast" : "slow",
  "-r",
  String(o.fps),
];

const AUDIO_CODEC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

const QUIET = ["-n", "-hide_banner", "-loglevel", "error"];

export function encoderArgs(o: EncoderOptions): string[] {
  return [
    ...QUIET,
    ...frameInput(o.fps),
    "-i",
    o.audio,
    "-map",
    "0:v",
    "-map",
    "1:a",
    ...videoCodecArgs(o),
    ...AUDIO_CODEC,
    "-movflags",
    "+faststart",
    "-t",
    String(o.duration),
    "-f",
    "mp4",
    o.out,
  ];
}

/** One chunk of a parallel render: its frames only, no audio. */
export function chunkEncoderArgs(o: VideoOptions): string[] {
  return [
    ...QUIET,
    ...frameInput(o.fps),
    "-an",
    ...videoCodecArgs(o),
    "-f",
    "mp4",
    o.out,
  ];
}

/** The concat demuxer's list of `files`, in order. */
export function concatList(files: readonly string[]): string {
  // In a quoted entry a quote is closed, escaped and reopened.
  return files.map((f) => `file '${f.replaceAll("'", "'\\''")}'\n`).join("");
}

/** The chunks (listed in `list`) joined bit-for-bit, under the whole film's audio. */
export function concatArgs(o: {
  list: string;
  audio: string;
  duration: number;
  out: string;
}): string[] {
  return [
    ...QUIET,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    o.list,
    "-i",
    o.audio,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    ...AUDIO_CODEC,
    "-movflags",
    "+faststart",
    "-t",
    String(o.duration),
    "-f",
    "mp4",
    o.out,
  ];
}

/** Run ffmpeg to completion; throws on a non-zero exit. */
export async function runFfmpeg(
  ffmpeg: string,
  args: readonly string[],
  what: string,
): Promise<void> {
  const proc = Bun.spawn([ffmpeg, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`film: ffmpeg exited with code ${code} ${what}`);
}

/** An encoder taking frames on stdin: `args` from `encoderArgs` or `chunkEncoderArgs`. */
export function startEncoder(
  ffmpeg: string,
  args: readonly string[],
  out: string,
): Encoder {
  const proc = Bun.spawn([ffmpeg, ...args], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  return {
    async frame(bytes) {
      // write() buffers; flush() resolves once ffmpeg drained it — the backpressure.
      await proc.stdin.write(bytes);
      await proc.stdin.flush();
    },
    async finish() {
      await proc.stdin.end();
      const code = await proc.exited;
      if (code !== 0)
        throw new Error(`film: ffmpeg exited with code ${code} writing ${out}`);
      return out;
    },
    abort() {
      proc.kill("SIGKILL");
    },
  };
}

/**
 * The web version of a finished film (`input`): what a page streams — ~10-20
 * MB for a two-minute film. 1080p at the film's frame rate, H.264 high
 * profile (yuv420p) at CRF 28 on the slow preset, its peaks capped at 2.5
 * Mbit/s (a time-lapse's noise would otherwise spend the budget), AAC 128k,
 * faststart. Chosen on the showcase film v18 (120.7 s → 18.4 MB at CRF 28,
 * the app's text as crisp as the master's; CRF 24 was 26.8 MB).
 */
export function webEncodeArgs(o: { input: string; out: string }): string[] {
  return [
    ...QUIET,
    "-i",
    o.input,
    "-map",
    "0:v",
    "-map",
    "0:a",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "slow",
    "-crf",
    "28",
    "-maxrate",
    "2500k",
    "-bufsize",
    "5000k",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    o.out,
  ];
}
