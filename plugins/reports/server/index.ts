import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { reportIdKind, reportsConfig } from "../core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { reportsListServed } from "./internal/list-resource";
import { IdKinds } from "@plugins/ids/server";

export { _reports } from "./internal/tables";
export { reportInvestigationSink } from "./internal/investigation-sink";
export { reportRecordedSignal } from "./internal/recorded-signal";
export type { InvestigationTaskRequest } from "./internal/investigation-sink";
export { ReportNoiseRule } from "./internal/noise-rules";
export type {
  ReportNoiseRuleSpec,
  ReportNoiseInput,
} from "./internal/noise-rules";
export { ReportKind, isReportKindRegistered } from "./internal/report-kinds";
export type {
  ReportKindSpec,
  ReportKindVariant,
  ReportRow,
} from "./internal/report-kinds";

export { getReportTitle } from "./internal/get-report-title";

// The portable half of reports: the table, its live read and the contracts the
// kinds and the engine meet on — every host boots it. Writing reports is the
// engine's (`reports/plugins/engine`: recordReport, the crash hooks, the change
// producer, retention, the routes), which needs the computer.
export default {
  description:
    "The reports table and its live read (reports.list), the ReportKind / ReportNoiseRule slots every kind and rule contributes to, and the fan-out ceiling config; recording is the engine's (reports/plugins/engine).",
  portable: true,
  contributions: [
    IdKinds.Kind({ kind: reportIdKind }),
    // `reports.list`: the Reports DataView's window, the detail pane's by-id
    // read and the kind / source filter options (see core/resources.ts).
    ...reportsListServed.declare,
    // The fan-out ceiling knobs the engine reads per admit (see the engine's
    // fan-out.ts). Registered here, on the portable half, so they are
    // live-tunable from Settings → Config on every host.
    ConfigV2.Register({ descriptor: reportsConfig }),
  ],
} satisfies ServerPluginDefinition;
