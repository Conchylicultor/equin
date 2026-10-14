import { implement } from "@plugins/infra/plugins/endpoints/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { submitClientSlowOp } from "../../shared/endpoints";
import { recordSlowOpBatch } from "./record-slow-op";
import { toRecordInputs } from "./client-record-input";

// Signals the browser queue had to discard under its own cap before this batch
// went out. A drop is real data loss, so it is recorded rather than swallowed:
// one line per batch that carried a non-zero count, on the same per-worktree
// JSONL substrate as the slow-op markers.
const dropChannel = defineLogSink({
  id: "slow-ops",
  description:
    "PERF sink: one line per client slow-op batch that arrived with a non-zero browser-side drop count.",
  consumer: {
    kind: "internal",
    note: "One line per client slow-op batch that arrived with a non-zero browser-side drop count (the beacon queue hit its 1000-item cap). Accounting for signals that never reached the recorder, so the loss is not silent; the durable slow-op SIGNAL itself is the slow-op report filed by the recorder.",
  },
});

// Client slow-op signals (page-load, element-settle, and the client latency
// signals — live update, write confirm) funnel into the same store as server
// spans. They carry no enclosing server span, but every signal except page-load
// supplies its own route caller; forward it through.
//
// The beacon is BATCHED — one POST per ~250 ms of queued signals rather than one
// per slow element, because one request per element amplified the very stall it
// reported. Per item the work is unchanged; only the batch's DB transaction and
// its trace (one per operationKind, see toRecordInputs) are shared.
export const handleClientSlowOp = implement(
  submitClientSlowOp,
  async ({ body }) => {
    if (body.dropped !== undefined && body.dropped > 0) {
      dropChannel.publish(
        JSON.stringify({
          atTime: new Date(),
          dropped: body.dropped,
          batchSize: body.items.length,
        }),
      );
    }

    const inputs = toRecordInputs(body.items, (item, batchCount) => {
      // Capture the server-side coherent instant AROUND receipt of this batch.
      // A slow client signal is ~all transport/server wait, so the server window
      // at receipt is exactly the evidence sought; its window is anchored at
      // receipt, not the client moment (documented clock-skew acceptability). The
      // trigger kind is the client operationKind ("page-load", "element",
      // "update", …) so it slots into the same open trigger vocabulary as server
      // spans.
      const trace = captureTrace({
        kind: item.operationKind,
        label: item.operation,
        durationMs: item.durationMs,
        thresholdMs: item.thresholdMs,
        detail: {
          caller: item.caller ?? null,
          // How many items of this kind the batch carried — this trace is the
          // slowest one's, and every one of them links to it.
          batchCount,
          waits: item.waits,
          variant: item.detail?.variant,
          transportColdStart: item.transportColdStart,
          // The browser's own boot decomposition (page-load only): the
          // client-boot trace class reads it off the trigger detail and
          // persists it as its section. recordSlowOpBatch below never receives
          // it — the aggregate row stays lean.
          clientBoot: item.clientBoot,
        },
      });
      return trace?.id;
    });
    await recordSlowOpBatch(inputs);
    return { ok: true };
  },
);
