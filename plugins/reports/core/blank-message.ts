// A report's message is required and never blank (ReportBodySchema): it is the
// one line a report is read by. Every collector builds it from what it caught,
// so a blank one is a bug in the collector — and that bug must not vanish with
// the report it emptied (a console line on a website visitor's browser is read
// by nobody). So the report is still filed, its message derived from the facts
// the report does carry, and saying in words that its filer left it blank.

/** The first stack line that names a location (a frame), if any. */
function firstFrame(stack: unknown): string | null {
  if (typeof stack !== "string") return null;
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (/^at\s|@|:\d+:\d+\)?$/.test(line)) return line.replace(/^at\s+/, "");
  }
  return null;
}

/**
 * The report's own message, or — when its filer left it blank — one derived
 * from its kind, source, error type and top frame. Never blank.
 */
export function reportMessageOrDerived(report: {
  kind: string;
  source: string;
  message: string;
  data: Record<string, unknown>;
}): string {
  if (report.message.trim() !== "") return report.message;
  const errorType =
    typeof report.data.errorType === "string" &&
    report.data.errorType.trim() !== ""
      ? report.data.errorType
      : null;
  const frame = firstFrame(report.data.stack);
  return [
    `${errorType ?? `${report.kind} report`} with no message`,
    frame === null ? "" : ` at ${frame}`,
    ` (its ${report.source} filer left the message blank — a collector bug)`,
  ].join("");
}
