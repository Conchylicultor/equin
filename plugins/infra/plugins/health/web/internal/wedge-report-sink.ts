import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

// Neutral wedge-report body owned by health. `discriminator` is the stable
// per-failure-mode key (folded into the crash fingerprint by the registrant);
// `message` is the already-composed human summary. No reports vocabulary leaks
// here — `reports.crash` registers the mapping to report({ kind: "crash", … }).
export interface WedgeReport {
  discriminator: string;
  message: string;
}

export const wedgeReportSink = defineReportSink<WedgeReport>(
  "infra/plugins/health:wedgeReportSink",
);
