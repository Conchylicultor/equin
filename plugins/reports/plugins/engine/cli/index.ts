// Shared CLI machinery, not a command (no default export): what `./equin push
// --fixes-report` asks of main's reports before it stamps the trailer.
export {
  fixesReportTrailer,
  resolveFixedReports,
} from "./internal/fixed-reports";
export type { FixedReports } from "./internal/fixed-reports";
