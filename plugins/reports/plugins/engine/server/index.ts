import {
  serverErrorSink,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { _reports } from "@plugins/reports/server";
import { submitReport } from "@plugins/reports/core";
import { handleReport } from "./internal/handle-report";
import { recordReport } from "./internal/record-report";
import { reportsProducer } from "./internal/producer";
import { backfillNoiseWarmup } from "./internal/backfill-noise";
import { reportsRetention } from "./internal/retention";
import {
  flushBufferedReports,
  processCrashHandler,
} from "./internal/process-hooks";
import { fatalReportHandler, serverReportHandler } from "./internal/fatal";

export {
  linkReportsToTask,
  renderReportTask,
  uninvestigatedReportCounts,
  uninvestigatedReports,
} from "./internal/uninvestigated";
export { recordReport, recordReportIncident } from "./internal/record-report";
export {
  reportOutboxFatalSink,
  reportOutboxSink,
} from "./internal/outbox-sink";
export { investigateReport } from "./internal/investigate";
export type { RecordReportResult } from "./internal/record-report";
export { recordReportDebounced } from "./internal/record-report-debounced";
export { DEFAULT_REPORT_DEBOUNCE_MS } from "./internal/debounce";
export type { StormSummary, StormRosterEntry } from "./internal/fan-out";

// The reports ENGINE: everything that writes the `reports` table, and the
// process-level crash capture that feeds it. Its parent's server barrel
// (`reports/server`) is the portable half — the table, `reports.list`, the
// ReportKind / ReportNoiseRule slots and the config — which a host without the
// computer boots; this barrel needs the computer (the crash buffer is a
// synchronous file append, the change producer and the fork exclusion are the
// desktop database's), so a browser host never loads it and its `reports.list`
// is the seed, read-only.
export default {
  description:
    "Records server/frontend crashes as deduped reports (recordReport: per-fingerprint velocity, per-kind fan-out ceiling, duress shedding, bell notifications), files investigation tasks on demand, files every crash the process's listeners catch (processCrashSink, in every boot mode: an uncaught exception synchronously — the crash buffer from a ready serving backend, the report outbox from anything else — and a survived rejection asynchronously), files server-core's typed reports (reportServer, async; exitWithFatalReport, synchronously on the way out) and replays the on-disk crash buffer, and owns the reports table's change producer, retention and fork exclusion.",
  httpRoutes: {
    [submitReport.route]: handleReport,
  },
  contributions: [
    // `reports` is change-sourced in-process, not by a feed trigger: every
    // write goes through `reportsProducer.mutate`, which routes the ids it
    // touched, coalesced to one flush per 2 s (see ./internal/producer.ts).
    // Mounting it is what keeps the feed from installing a trigger on the table.
    reportsProducer.declare,
    // A report records a crash on the machine that crashed, and its
    // investigation link points at a task in the SAME database. A fresh
    // worktree inheriting main's crash history gets a bell full of failures it
    // did not cause and links into main's tasks.
    ExcludeFromFork({
      table: _reports,
      reason:
        "Host-local crash history; inherited rows surface main's failures in a fresh worktree and link to tasks it cannot resolve.",
    }),
  ],
  register: [backfillNoiseWarmup, reportsRetention],
  // Every caught server error becomes a crash report. A `sinkHandlers` entry,
  // so it is attached in every boot mode (an exec child's errors are filed
  // too), and what was reported before it attached is replayed.
  sinkHandlers: [
    sinkHandler(serverErrorSink, () => (report) => {
      void recordReport({
        kind: "crash",
        source: "server-caught",
        message: report.message,
        data: {
          errorType: report.errorType,
          stack: report.stack,
          scope: report.scope ?? null,
        },
      });
    }),
    // A typed report from a process that lives on (`reportServer`) — async
    // (./internal/fatal.ts).
    serverReportHandler,
    // A report filed synchronously before a deliberate exit
    // (`exitWithFatalReport`) — in an exec child too, which never runs
    // `onReady` (./internal/fatal.ts).
    fatalReportHandler,
    // Every uncaught exception and unhandled rejection the process's listeners
    // catch — server-core installs them at each process entry point, so an
    // exec child's crash is filed too (./internal/process-hooks.ts).
    processCrashHandler,
  ],
  onReady: async () => {
    // Drain the on-disk crash buffer from the previous boot (crashes, and fatal
    // reports a deliberate exit filed). Near-instant (a small JSONL file); the
    // heavy `_reports` scan is the deferred backfill warm-up
    // (backfillNoiseWarmup). Serve-only, as `onReady` is: only the serving
    // backend writes the buffer.
    //
    // A buffered line's kind must be registered by some plugin in the
    // composition for the replay to resolve. It is: `collectContributions()`
    // runs over every plugin BEFORE any `onReady` (server-core
    // `bin/index.ts`), so every ReportKind contribution is in the registry by
    // the time this flush reads the file.
    await flushBufferedReports();
  },
} satisfies ServerPluginDefinition;
