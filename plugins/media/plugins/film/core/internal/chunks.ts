// How a render splits a film's frames among parallel pages. Frame i of a
// render of [from, to) always shows film time `from + i / fps`, whichever
// chunk renders it — so the chunks are a partition of the frame indices, and
// their concatenation is the serial render's frame sequence.

/** Frames [start, end) of a render: frame i shows `frameTime(from, i, fps)`. */
export interface FrameRange {
  start: number;
  end: number;
}

/** How many frames a render of `duration` seconds at `fps` has. */
export function frameCount(duration: number, fps: number): number {
  if (!(duration > 0) || !(fps > 0))
    throw new Error(`film: no frames in ${duration} s at ${fps} fps`);
  return Math.round(duration * fps);
}

/** The film time frame `i` of a render starting at `from` shows. */
export function frameTime(from: number, i: number, fps: number): number {
  return from + i / fps;
}

/**
 * `frames` split into at most `workers` contiguous, non-empty ranges, in
 * order, covering [0, frames) exactly; sizes differ by at most one frame (the
 * longer ones first). Fewer ranges than workers when a range would hold fewer
 * than `minFrames` frames: opening a page costs seconds, so a tiny chunk is
 * slower than no chunk.
 */
export function splitFrames(
  frames: number,
  workers: number,
  minFrames = 1,
): FrameRange[] {
  if (!Number.isInteger(frames) || frames < 1)
    throw new Error(`film: cannot split ${frames} frames`);
  if (!Number.isInteger(workers) || workers < 1)
    throw new Error(`film: ${workers} workers — need a positive integer`);
  if (!Number.isInteger(minFrames) || minFrames < 1)
    throw new Error(`film: minFrames ${minFrames} — need a positive integer`);
  const parts = Math.max(1, Math.min(workers, Math.floor(frames / minFrames)));
  const base = Math.floor(frames / parts);
  const extra = frames % parts;
  const ranges: FrameRange[] = [];
  let start = 0;
  for (let k = 0; k < parts; k++) {
    const end = start + base + (k < extra ? 1 : 0);
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

/**
 * Logical cores one worker keeps busy: a Chromium renderer painting and
 * screenshotting, plus a multithreaded x264 encoding its chunk. Past
 * cores / this, workers only contend (measured: see the plugin's CLAUDE.md).
 */
const CORES_PER_WORKER = 3;

/** The default number of pages a render runs at once on a host with `cores` logical cores. */
export function defaultWorkers(cores: number): number {
  return Math.max(1, Math.floor(cores / CORES_PER_WORKER));
}
