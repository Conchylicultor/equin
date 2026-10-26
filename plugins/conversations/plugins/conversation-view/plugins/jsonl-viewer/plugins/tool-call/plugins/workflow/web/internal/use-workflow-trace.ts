import { useEffect, useState } from "react";
import { traceWorkflow } from "./trace-workflow";
import type { TracedGraph, TraceStatus } from "./trace-types";

interface TraceState {
  graph: TracedGraph | null;
  status: TraceStatus;
}

/** A settled trace, remembering which script it is the trace of. */
interface SettledTrace extends TraceState {
  script: string;
}

/**
 * Trace-executes `script` and returns the recovered agent DAG. The trace is
 * async (the script body awaits), so this resolves on a microtask; `status`
 * is "tracing" for the first tick, then "ready" (graph present) or "fallback"
 * (no inline script, or the trace threw — caller renders the meta-only view).
 *
 * The status is derived against the script it was computed for, so a script
 * that just arrived (the transcript loaded after mount) reads "tracing" on its
 * first render rather than the previous script's settled state.
 */
export function useWorkflowTrace(script: string, args: unknown): TraceState {
  const [settled, setSettled] = useState<SettledTrace | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- async trace-execution of the workflow script (a local async computation, not a server read, so a live read (useLive) does not apply); the cancelled guard prevents stale setState and no cleaner primitive owns this. */
    if (!script) return;
    let cancelled = false;
    setSettled(null);
    void traceWorkflow(script, args).then((graph) => {
      if (cancelled) return;
      setSettled(
        graph
          ? { script, graph, status: "ready" }
          : { script, graph: null, status: "fallback" },
      );
    });
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      cancelled = true;
    };
  }, [script, args]);

  if (!script) return { graph: null, status: "fallback" };
  if (settled === null || settled.script !== script) {
    return { graph: null, status: "tracing" };
  }
  return { graph: settled.graph, status: settled.status };
}
