import { useCallback, useEffect, useRef, useState } from "react";
import { readNdjson } from "@plugins/infra/plugins/ndjson-stream/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { interpolatePath } from "@plugins/infra/plugins/endpoints/core";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import {
  getSlowOpsCluster,
  ClusterWorktreeSchema,
  type ClusterWorktree,
} from "../../shared/endpoints";

export type ClusterStreamStatus = "streaming" | "done" | "error";

// Cap intermediate renders at ~this many across the whole fan-out. The flush
// interval is derived from `total` so a small cluster (~16) flushes every frame
// (live per-worktree progress) while a many-worktree host (1000+) batches —
// each render recomputes the aggregate + timeline over the whole accumulator,
// so a per-frame flush there would be O(n²) and jank the main thread.
const MAX_RENDERS = 40;

export interface ClusterStream {
  worktrees: ClusterWorktree[];
  total: number | null;
  status: ClusterStreamStatus;
  error: string | null;
  reload: () => Promise<void>;
}

// Owns the NDJSON streaming lifecycle for the cluster fan-out: it consumes the
// `{ total }` → `{ worktree }`… → `{ end }` frame protocol, exposing determinate
// progress via `total` and flushing accumulated worktrees on an interval scaled
// to `total` (see MAX_RENDERS) so the view fills in live without O(n²) renders
// on a many-worktree host. Any in-flight stream is aborted before a new
// `reload()` and on unmount, so a superseded/unmounted stream resolves silently
// instead of writing stale state.
export function useClusterStream(): ClusterStream {
  const [worktrees, setWorktrees] = useState<ClusterWorktree[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<ClusterStreamStatus>("streaming");
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transport = useTransport();

  const reload = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setWorktrees([]);
    setTotal(null);
    setStatus("streaming");
    setError(null);

    const acc: ClusterWorktree[] = [];
    let ended = false;
    let sinceFlush = 0;
    // Flush interval derived once `{ total }` arrives (always the first frame);
    // until then flush every frame so the very first worktrees show immediately.
    let flushEvery = 1;
    try {
      for await (const frame of readNdjson(
        transport,
        getSlowOpsCluster.route,
        interpolatePath(getSlowOpsCluster.path, {}),
        { signal: ctrl.signal },
      )) {
        if ("error" in frame) throw new Error(String(frame.error));
        if ("total" in frame) {
          const t = Number(frame.total);
          setTotal(t);
          flushEvery = Math.max(1, Math.ceil(t / MAX_RENDERS));
          continue;
        }
        if ("end" in frame) {
          ended = true;
          continue;
        }
        acc.push(ClusterWorktreeSchema.parse((frame as { worktree: unknown }).worktree));
        if (++sinceFlush >= flushEvery) {
          sinceFlush = 0;
          setWorktrees([...acc]);
        }
      }
      // A dropped socket yields no terminal sentinel — fail loud rather than
      // present a partial cluster as if the fan-out completed.
      if (!ended) throw new Error("cluster stream truncated");
      setWorktrees([...acc]); // final flush — render the trailing partial batch
      setStatus("done");
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded by a newer reload / unmount
      setStatus("error");
      setError(getEndpointErrorMessage(e));
    }
  }, [transport]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- NDJSON streaming accumulator: reload() drives setWorktrees/setTotal/setStatus/setError from the cluster fan-out's {total}→{worktree}…→{end} frames with a total-scaled batched flush; the AbortController guards stale/unmount writes. No request/response primitive (useEndpoint) handles a progressive NDJSON stream, so this can't be derived in render.
    void reload();
  }, [reload]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { worktrees, total, status, error, reload };
}
