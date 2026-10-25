import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { TimelineFrame } from "../../shared/frames";
import { produceTimeline } from "./produce";

// In-process collection of the timeline producer's frames for the get_timeline
// MCP tool: the same producer the debug.timeline.scan value folds
// (scan-served.ts), pushed into an array. Wrapped in the SAME background-lane +
// profiling-suppressed guard the scan uses — observability must never feed the
// profiler or ride the interactive lane (anti-amplification).
export async function collectTimeline(fromMs: number, toMs: number): Promise<TimelineFrame[]> {
  const frames: TimelineFrame[] = [];
  await runInBackgroundLane(() =>
    runWithoutProfiling(() => produceTimeline((frame) => frames.push(frame), fromMs, toMs)),
  );
  return frames;
}
