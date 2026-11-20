import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";

/** Emits one frame: a JSON object written as one line. */
export type NdjsonEmit = (frame: object) => void;

export interface NdjsonResponseOptions {
  /**
   * The request's own abort signal (`req.signal`): aborting it aborts the
   * producer's signal, like a reader cancelling the stream does.
   */
  readonly signal?: AbortSignal;
}

/**
 * Wraps a producer into a streaming NDJSON (`application/x-ndjson`) Response.
 * The producer emits frames; an unexpected throw is framed as
 * `{"error": message}`; the stream always closes.
 *
 * `produce` is handed an AbortSignal that fires when the reader goes away —
 * the stream cancelled (a client disconnect) or `opts.signal` aborted — so a
 * long-lived producer (a LISTEN, a heartbeat timer) releases what it holds and
 * returns. Once it fired, `emit` drops the frame (there is no one to read
 * it); a producer error other than the abort itself is then rethrown as an
 * unhandled rejection rather than lost with the stream.
 */
export function ndjsonResponse(
  produce: (emit: NdjsonEmit, signal: AbortSignal) => Promise<void>,
  opts: NdjsonResponseOptions = {},
): Response {
  const encoder = new TextEncoder();
  const gone = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => gone.abort(outer?.reason);
  if (outer?.aborted) onOuterAbort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  // Set only by the reader's cancel: the controller is closed then, and must
  // not be closed again. An aborted request leaves it open, so it is closed.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: NdjsonEmit = (frame) => {
        if (gone.signal.aborted) return;
        controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      };
      try {
        await produce(emit, gone.signal);
      } catch (e) {
        if (!gone.signal.aborted) {
          emit({ error: e instanceof Error ? e.message : String(e) });
        } else if (e !== gone.signal.reason) {
          void runTracked(
            "ndjson-stream: producer failed after its reader left",
            () => Promise.reject(e),
          );
        }
      } finally {
        outer?.removeEventListener("abort", onOuterAbort);
        if (!cancelled) controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      gone.abort(reason);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
