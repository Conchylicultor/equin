import {
  defineReportSink,
  defineRequestSink,
} from "@plugins/primitives/plugins/report-sink/core";
import type { ServerReport } from "@plugins/framework/plugins/server-core/core";
import type { ReportInput } from "@plugins/reports/core";

/**
 * Reports `recordReport` was asked to file in a process that cannot write
 * `reports` (an exec child — a supervised job's body — or a CLI: the
 * producer's A13). `reports/outbox` attaches the writer (a `sinkHandlers`
 * entry, so in every boot mode): each lands in the host-global outbox, which
 * main's backend drains and records. A sink rather than an import because the
 * outbox's drain records through the engine. Held until the writer attaches,
 * so a report from early in a child's boot is not lost.
 */
export const reportOutboxSink = defineReportSink<ReportInput>();

/**
 * The synchronous twin of {@link reportOutboxSink}: a fatal report
 * (`exitWithFatalReport`) from a process that cannot write `reports`, whose
 * next statement is `process.exit()`. `reports/outbox` attaches the writer the
 * same way; it answers whether the entry is in place. A request sink — never
 * held: a report held past the exit is lost anyway, and the caller must know.
 */
export const reportOutboxFatalSink = defineRequestSink<ServerReport, boolean>();
