import {
  MAX_MANIFEST_STEPS,
  type RecordingManifest,
  type RecordingStep,
} from "@plugins/debug/plugins/browser-recordings/core";

/** How many calls a step stands for. */
function callsOf(step: RecordingStep): number {
  return step.repeat ?? 1;
}

/** Whether `next` repeats `prev`: the same call, ending on the same picture, neither failing. */
function repeats(prev: RecordingStep, next: RecordingStep): boolean {
  return (
    prev.title === next.title &&
    prev.frame === next.frame &&
    prev.error === undefined &&
    next.error === undefined
  );
}

/**
 * PURE. A run's steps as its manifest keeps them: consecutive identical calls
 * (a poll loop) folded into one step with a `repeat` count, then — when more
 * than `max` remain — the first and last halves kept and the calls between
 * them counted in `omitted`, so the manifest stays bounded however long the
 * script ran.
 */
export function boundSteps(
  steps: readonly RecordingStep[],
  max: number = MAX_MANIFEST_STEPS,
): Pick<RecordingManifest, "steps" | "omitted"> {
  const folded: RecordingStep[] = [];
  for (const step of steps) {
    const prev = folded.at(-1);
    if (prev !== undefined && repeats(prev, step)) {
      folded[folded.length - 1] = {
        ...prev,
        durationMs: step.startMs + step.durationMs - prev.startMs,
        repeat: callsOf(prev) + callsOf(step),
      };
      continue;
    }
    folded.push({ ...step });
  }
  if (folded.length <= max) return { steps: folded };
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const dropped = folded.slice(head, folded.length - tail);
  return {
    steps: [...folded.slice(0, head), ...folded.slice(folded.length - tail)],
    omitted: {
      at: head,
      calls: dropped.reduce((n, s) => n + callsOf(s), 0),
    },
  };
}
