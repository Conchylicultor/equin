import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import { reportOutboxSink } from "@plugins/reports/plugins/engine/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { fileReportFromProcess } from "../../core";

// The writes still in flight: a process must not exit before they land.
const inFlight = new Set<Promise<unknown>>();

/**
 * The engine's `reportOutboxSink` → the outbox: a report `recordReport` was
 * asked to file in a process that cannot write `reports` (an exec child, a
 * CLI) becomes one outbox entry. A `sinkHandlers` entry, attached in every
 * boot mode. `fileReportFromProcess` never rejects (it prints why it failed).
 */
export const outboxWriter = sinkHandler(reportOutboxSink, () => (input) => {
  const write: Promise<void> = runTracked("report-outbox:write", async () => {
    try {
      await fileReportFromProcess({
        kind: input.kind,
        message: input.message ?? "",
        data: input.data,
      });
    } finally {
      inFlight.delete(write);
    }
  });
  inFlight.add(write);
});

/** Every outbox write started so far, landed — before the process exits. */
export async function settleOutboxWrites(): Promise<void> {
  await Promise.all(inFlight);
}
