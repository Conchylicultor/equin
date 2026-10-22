import { useCallback, useEffect, useRef, useState } from "react";
import { readNdjson } from "@plugins/infra/plugins/ndjson-stream/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { interpolatePath } from "@plugins/infra/plugins/endpoints/core";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import {
  getTimeline,
  TimelineFrameSchema,
  type TimelineChunk,
  type TimelineHealthFrame,
} from "../../shared/frames";
import type { TimelineWindow } from "./view-model";

export type TimelineStreamStatus = "streaming" | "done" | "error";

// Cap intermediate renders across the whole fan-out — the cluster tab's
// batched-flush shape: a small fan-out flushes every chunk (live progress), a
// many-worktree host batches so each recompute-over-the-accumulator render
// stays off the O(n²) path.
const MAX_RENDERS = 40;

export interface TimelineStream {
  /** The wall-clock window of the CURRENT data, frozen at reload time. */
  range: TimelineWindow | null;
  chunks: TimelineChunk[];
  health: TimelineHealthFrame[];
  /** Planned chunk count from the `{ total }` frame (null until it arrives). */
  total: number | null;
  status: TimelineStreamStatus;
  error: string | null;
  reload: () => Promise<void>;
}

// Owns the NDJSON lifecycle for GET /api/debug/timeline: pull-only (mount,
// Refresh, lookback change — never live, never polled), consuming the
// `{total}` → `{chunk}`/`{health}`… → `{end}` protocol with every line parsed
// against TimelineFrameSchema (contract drift fails loud, not silently
// blank). An in-flight stream is aborted before a new reload() and on
// unmount, so a superseded stream resolves silently instead of writing stale
// state. Mirrors the cluster tab's useClusterStream.
export function useTimelineStream(lookbackMs: number): TimelineStream {
  const [range, setRange] = useState<TimelineWindow | null>(null);
  const [chunks, setChunks] = useState<TimelineChunk[]>([]);
  const [health, setHealth] = useState<TimelineHealthFrame[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<TimelineStreamStatus>("streaming");
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transport = useTransport();

  const reload = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const toMs = Date.now();
    const win: TimelineWindow = { fromMs: toMs - lookbackMs, toMs };
    setRange(win);
    setChunks([]);
    setHealth([]);
    setTotal(null);
    setStatus("streaming");
    setError(null);

    const accChunks: TimelineChunk[] = [];
    const accHealth: TimelineHealthFrame[] = [];
    const flush = (): void => {
      setChunks([...accChunks]);
      setHealth([...accHealth]);
    };
    let ended = false;
    let sinceFlush = 0;
    // Derived once `{ total }` arrives (always the first frame); until then
    // flush every frame so the first worktrees show immediately.
    let flushEvery = 1;
    try {
      const url = `${interpolatePath(getTimeline.path, {})}?fromMs=${win.fromMs}&toMs=${win.toMs}`;
      for await (const raw of readNdjson(transport, getTimeline.route, url, {
        signal: ctrl.signal,
      })) {
        const frame = TimelineFrameSchema.parse(raw);
        // The ndjsonResponse whole-stream-failure auto-frame (distinct from a
        // per-cell ok:false chunk, which stays a compact error row).
        if ("error" in frame) throw new Error(frame.error);
        if ("total" in frame) {
          setTotal(frame.total);
          flushEvery = Math.max(1, Math.ceil(frame.total / MAX_RENDERS));
          continue;
        }
        if ("end" in frame) {
          ended = true;
          continue;
        }
        if ("health" in frame) {
          accHealth.push(frame.health);
          continue;
        }
        accChunks.push(frame.chunk);
        if (++sinceFlush >= flushEvery) {
          sinceFlush = 0;
          flush();
        }
      }
      // A dropped socket yields no terminal sentinel — fail loud rather than
      // present a partial timeline as if the fan-out completed.
      if (!ended) throw new Error("timeline stream truncated");
      flush(); // final flush — the trailing partial batch + late health frames
      setStatus("done");
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded by a newer reload / unmount
      setStatus("error");
      setError(getEndpointErrorMessage(e));
    }
  }, [lookbackMs, transport]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- NDJSON streaming accumulator (the cluster-tab pattern): reload() drives the state from the {total}→{chunk}/{health}…→{end} frames with a total-scaled batched flush; the AbortController guards stale/unmount writes. No request/response primitive (useEndpoint) handles a progressive NDJSON stream, so this can't be derived in render. Re-fires on lookback change by design (fetch on preset change).
    void reload();
  }, [reload]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { range, chunks, health, total, status, error, reload };
}
