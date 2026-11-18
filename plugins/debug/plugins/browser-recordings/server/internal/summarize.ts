import {
  MAX_STRIP_FRAMES,
  type BrowserRecordingRun,
  type RecordingManifest,
  type StripFrame,
} from "../../core";

/** A strip frame before its file is stat'ed. */
export type UnversionedFrame = Omit<StripFrame, "version">;

/**
 * One thumbnail per picture: consecutive steps that ended on the same frame
 * (a wait, an evaluate) fold into the last of them — or the failing one.
 */
export function distinctFrames(
  steps: RecordingManifest["steps"],
): UnversionedFrame[] {
  const out: UnversionedFrame[] = [];
  steps.forEach((step, index) => {
    if (step.frame === undefined) return;
    const shown: UnversionedFrame = {
      frame: step.frame,
      title: step.title,
      step: index + 1,
      ...(step.error !== undefined ? { error: step.error } : {}),
    };
    const prev = out.at(-1);
    if (prev?.frame === step.frame) {
      if (prev.error === undefined) out[out.length - 1] = shown;
      return;
    }
    out.push(shown);
  });
  return out;
}

/**
 * PURE. A run as its filmstrip draws it: the counts, and at most
 * `MAX_STRIP_FRAMES` frames — the first and last halves when there are more,
 * with the gap between them named.
 */
export function summarizeRun(
  manifest: RecordingManifest,
  dir: string,
  max: number = MAX_STRIP_FRAMES,
): Omit<BrowserRecordingRun, "strip"> & { strip: UnversionedFrame[] } {
  const frames = distinctFrames(manifest.steps);
  const omittedCalls = manifest.omitted?.calls ?? 0;
  let calls = omittedCalls;
  let failed = 0;
  for (const step of manifest.steps) {
    calls += step.repeat ?? 1;
    if (step.error !== undefined) failed++;
  }
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const cut = frames.length > max;
  return {
    dir,
    source: manifest.source,
    startedAt: manifest.startedAt,
    calls,
    steps: manifest.steps.length,
    failed,
    omittedCalls,
    frames: frames.length,
    strip: cut
      ? [...frames.slice(0, head), ...frames.slice(frames.length - tail)]
      : frames,
    stripGap: cut ? { at: head, frames: frames.length - max } : null,
  };
}
