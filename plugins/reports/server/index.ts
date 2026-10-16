import {
  setErrorReporter,
  setFatalReporter,
} from "@plugins/framework/plugins/server-core/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleReport } from "./internal/handle-report";
import { handleInvestigate } from "./internal/handle-investigate";
import { reportsConfig } from "../core";
import { recordReport } from "./internal/record-report";
import { ConfigV2 } from "@plugins/config_v2/server";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { _reports } from "./internal/tables";
import { reportsProducer } from "./internal/producer";
import { reportsListServed } from "./internal/list-resource";
import { backfillNoiseWarmup } from "./internal/backfill-noise";
import { reportsRetention } from "./internal/retention";
import {
  flushBufferedReports,
  installProcessHooks,
} from "./internal/process-hooks";
import { appendFatalReportSync } from "./internal/buffer";
import { submitReport, investigateReport } from "../shared/endpoints";
import { IdKinds } from "@plugins/ids/server";
import { reportIdKind } from "../core";

export { _reports } from "./internal/tables";
export { reportInvestigationSink } from "./internal/investigation-sink";
export { reportRecordedSignal } from "./internal/recorded-signal";
export {
  linkReportsToTask,
  renderReportTask,
  uninvestigatedReportCounts,
  uninvestigatedReports,
} from "./internal/uninvestigated";
export type { InvestigationTaskRequest } from "./internal/investigation-sink";
export { recordReport } from "./internal/record-report";
export { recordReportDebounced } from "./internal/record-report-debounced";
export { DEFAULT_REPORT_DEBOUNCE_MS } from "./internal/debounce";
export { ReportNoiseRule } from "./internal/noise-rules";
export type {
  ReportNoiseRuleSpec,
  ReportNoiseInput,
} from "./internal/noise-rules";
export { ReportKind, isReportKindRegistered } from "./internal/report-kinds";
export type { RecordReportResult } from "./internal/record-report";
export type { StormSummary, StormRosterEntry } from "./internal/fan-out";
export type {
  ReportKindSpec,
  ReportKindVariant,
  ReportRow,
} from "./internal/report-kinds";

export { getReportTitle } from "./internal/get-report-title";
export default {
  description:
    "Records server/frontend crashes as deduped reports; investigation tasks are filed on demand.",
  httpRoutes: {
    [submitReport.route]: handleReport,
    [investigateReport.route]: handleInvestigate,
  },
  contributions: [
    IdKinds.Kind({ kind: reportIdKind }),
    // `reports.list`: the Reports DataView's window, the detail pane's by-id
    // read and the kind / source filter options (see core/resources.ts).
    ...reportsListServed.declare,
    // The fan-out ceiling knobs (see server/internal/fan-out.ts). Registered
    // here so they are live-tunable from Settings → Config — the engine reads
    // them per admit.
    ConfigV2.Register({ descriptor: reportsConfig }),
    // `reports` is change-sourced in-process, not by a feed trigger: every
    // write goes through `reportsProducer.mutate`, which routes the ids it
    // touched, coalesced to one flush per 2 s (see server/internal/producer.ts).
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
