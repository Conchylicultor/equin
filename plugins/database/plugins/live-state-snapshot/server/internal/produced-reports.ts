import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";

// The A6 reports (./produced-guard), held until every plugin's `onReady` has
// run — the reports plugin installs server-core's error reporter in ITS
// `onReady`, and `reportServerError` drops anything filed before that. The
// plugin's `onAllReady` calls `openProducedPersistReports()`, which replays
// what was held and files the rest as they come.
export const producedPersistReports = defineReportSink<string>();

// A persisted key whose code digest failed (`./code-stamp`), held the same way.
export const codeDigestReports = defineReportSink<string>();

export function openProducedPersistReports(): void {
  producedPersistReports.register((message) => {
    reportServerError({ message, errorType: "ProducedTablePersisted" });
  });
  codeDigestReports.register((message) => {
    reportServerError({ message, errorType: "L2CodeDigestFailed" });
  });
}
