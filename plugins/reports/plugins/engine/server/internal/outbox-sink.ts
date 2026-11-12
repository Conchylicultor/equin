import {
  defineReportSink,
  defineRequestSink,
} from "@plugins/primitives/plugins/report-sink/core";
import {
  defineServerContribution,
  type ServerReport,
} from "@plugins/framework/plugins/server-core/core";
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

/**
 * What attaches the writers of {@link reportOutboxSink} and
 * {@link reportOutboxFatalSink}: `reports/outbox`'s `server/`. The engine
 * cannot import it (the outbox's drain records through the engine), so the
 * need is a COMPANION kind: the outbox contributes `ReportOutboxWriter({
 * companion: true, reason })`, and the closure engine ships it wherever the
 * engine ships. Without it a composition's exec children (and a backend before
 * it serves) emitted into a sink nobody drained — the engine held their
 * reports and dropped them. It used to ship only by accident, in the
 * compositions where some plugin happened to import the outbox's writer.
 */
export const ReportOutboxWriter = defineServerContribution<{
  /** What writes the outbox, and in which boot modes. */
  reason: string;
}>("reports-outbox-writer", {
  companions: true,
  docLabel: (p) => p.reason,
});
