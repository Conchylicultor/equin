// The video encoder: rendered frames on stdin (JPEG), the mixed audio WAV as
// a second input, out as H.264 (yuv420p) + AAC 192k in an MP4 with faststart.

export interface Encoder {
  /** Write one frame (all frames the same format and size). Backpressure-safe. */
  frame(bytes: Uint8Array): Promise<void>;
  /** Close the stream, wait for ffmpeg, resolve with the output path. */
  finish(): Promise<string>;
}

export interface EncoderOptions {
  ffmpeg: string;
  out: string;
  fps: number;
  width: number;
  height: number;
  audio: string;
  duration: number;
  /** Faster preset, higher CRF. */
  preview: boolean;
}

export function encoderArgs(o: EncoderOptions): string[] {
  return [
    // Never overwrite: a film is a version (runFilm refuses first; this makes
    // the encoder itself unable to replace one).
    "-n",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(o.fps),
    "-c:v",
    "mjpeg",
    "-i",
    "pipe:0",
    "-i",
    o.audio,
    "-map",
    "0:v",
    "-map",
    "1:a",
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
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-t",
    String(o.duration),
    o.out,
  ];
}

export function startEncoder(o: EncoderOptions): Encoder {
  const proc = Bun.spawn([o.ffmpeg, ...encoderArgs(o)], {
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
        throw new Error(
          `film: ffmpeg exited with code ${code} writing ${o.out}`,
        );
      return o.out;
    },
  };
}
