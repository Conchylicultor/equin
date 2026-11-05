import { serverErrorSink, type ServerErrorReport } from "../error-reporter";

/**
 * Route every `reportServerError` to `fn` — or to nobody (`null`) — discarding
 * whatever was held before, so a suite never receives another suite's reports.
 */
export function setServerErrorHandler(
  fn: ((report: ServerErrorReport) => void) | null,
): void {
  serverErrorSink.register(null);
  serverErrorSink.register(fn);
}
