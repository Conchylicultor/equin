import {
  setErrorReporter,
  setFatalReporter,
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
  installProcessHooks,
} from "./internal/process-hooks";
import { appendFatalReportSync } from "./internal/buffer";

export {
  linkReportsToTask,
  renderReportTask,
  uninvestigatedReportCounts,
  uninvestigatedReports,
} from "./internal/uninvestigated";
export { recordReport } from "./internal/record-report";
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
    "Records server/frontend crashes as deduped reports (recordReport: per-fingerprint velocity, per-kind fan-out ceiling, duress shedding, bell notifications), files investigation tasks on demand, installs the process crash hooks and replays the on-disk crash buffer, and owns the reports table's change producer, retention and fork exclusion.",
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
  onReady: async () => {
    // Cheap, serving-critical error-capture wiring stays EAGER: it installs the
    // process crash hooks + the server error reporter and drains the on-disk
    // crash buffer from the previous boot. These are near-instant (register a
    // listener; flush a small JSONL buffer) and must run before first request so
    // crashes are captured from t=0. Only the heavy `_reports` scan moved to the
    // deferred/throttled backfill warm-up (see backfillNoiseWarmup).
    installProcessHooks();
    setErrorReporter((report) => {
      void recordReport({
        kind: "crash",
        source: "server-caught",
        message: report.message,
        data: { errorType: report.errorType, stack: report.stack },
      });
    });
    // The synchronous twin, for a backend on its way out of a deliberate exit.
    // It cannot go through `recordReport` for the same reason the crash hooks
    // cannot: that is a Postgres write, and the caller's next statement is
    // `process.exit()`. So it takes the SAME durable path as a crash — one
    // appended JSONL line, replayed by the `flushBufferedReports()` below on
    // the next boot — and the only thing it adds is that the line names its own
    // kind, so it comes back as itself instead of as an anonymous crash.
    //
    // The kind must be registered by some plugin in the composition for that
    // replay to resolve. It is: `collectContributions()` runs over every plugin
    // BEFORE any `onReady` (server-core `bin/index.ts`), so every ReportKind
    // contribution is in the registry by the time this flush reads the file.
    setFatalReporter((report) => {
      appendFatalReportSync({
        source: "server-fatal",
        kind: report.kind,
        message: report.message,
        data: report.data ?? {},
      });
    });
    await flushBufferedReports();
  },
} satisfies ServerPluginDefinition;
