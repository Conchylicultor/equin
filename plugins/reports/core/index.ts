export { reportsList, REPORTS_SEARCHABLE } from "./resources";
export type { Report } from "./resources";
export { reportsRootRoute, reportDetailRoute } from "./routes";
export {
  SERVER_REPORT_SOURCES,
  CLIENT_REPORT_SOURCES,
  isStaleOrigin,
} from "./sources";
export { reportsConfig } from "./config";
export type { ReportSource } from "./sources";
export type { ReportFingerprintContext } from "./fingerprint";
export { normalizeMessage } from "./message-identity";
export { reportIdKind } from "./id-kind";
export type { ReportId } from "./id-kind";
export {
  reportActivity,
  reportHourOf,
  formatRecentCount,
  formatReportActivity,
} from "./activity";
export type { ReportActivity, ReportActivityInput } from "./activity";
export {
  REPORT_HOURLY_MAX,
  REPORT_RECENT_MAX,
  reportFields,
  reportsEntityRef,
  type ReportHourly,
  type ReportOccurrence,
} from "./entity";
// The report contract every runtime shares: the HTTP body the browser posts
// (and `recordReport`'s input, widened to server sources), and the two engine
// routes. Declared here, not in a plugin-private shared/, because the engine
// that serves them is a child plugin (`reports/plugins/engine`).
export type { ReportBody, ReportInput } from "./report-body";
export {
  FIXES_REPORT_TRAILER,
  REPORT_FIXED_BY_TRAILER,
  REPORT_FIX_STATES,
  fixedByClaim,
  REPORT_FIX_STATE_LABELS,
  fixStandingOf,
  regresses,
} from "./fix-state";
export type {
  ReportFixFacts,
  ReportFixStanding,
  ReportFixState,
} from "./fix-state";
export { submitReport, investigateReport } from "./endpoints";
export type { ReportResult } from "./endpoints";
