export { reportsList, REPORTS_SEARCHABLE } from "./resources";
export type { Report } from "./resources";
export { reportsRootRoute, reportDetailRoute } from "./routes";
export { SERVER_REPORT_SOURCES, CLIENT_REPORT_SOURCES } from "./sources";
export { reportsConfig } from "./config";
export type { ReportSource } from "./sources";
export type { ReportFingerprintContext } from "./fingerprint";
export { reportIdKind } from "./id-kind";
export type { ReportId } from "./id-kind";
export { reportFields, reportsEntityRef } from "./entity";
// The report contract every runtime shares: the HTTP body the browser posts
// (and `recordReport`'s input, widened to server sources), and the two engine
// routes. Declared here, not in a plugin-private shared/, because the engine
// that serves them is a child plugin (`reports/plugins/engine`).
export type { ReportBody, ReportInput } from "./report-body";
export { submitReport, investigateReport } from "./endpoints";
export type { ReportResult } from "./endpoints";
