import type { Report } from "@plugins/reports/core";

// One-line crash summary: "errorType: message" when an error type is present,
// otherwise the bare message — reproducing the original crash row rendering.
export function CrashSummary({ report }: { report: Report }) {
  const errorType =
    typeof report.data.errorType === "string" ? report.data.errorType : null;
  const foreign = report.data.codeOrigin === "foreign" ? "[not our code] " : "";
  return (
    <>
      {foreign}
      {errorType ? `${errorType}: ${report.message}` : report.message}
    </>
  );
}
