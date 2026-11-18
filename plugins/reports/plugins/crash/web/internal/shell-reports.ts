import { report } from "@plugins/reports/web";
import { ReportBodySchema } from "@plugins/reports/core";
import { SHELL_REPORT_QUEUE_GLOBAL } from "../../core";

/** What the shell pushes: a report body, checked before it is sent. */
function deliver(body: unknown): void {
  const parsed = ReportBodySchema.safeParse(body);
  if (!parsed.success) {
    // The shell is plain JS no type reaches: a body it got wrong is a bug in
    // it, filed as one rather than dropped.
    void report({
      kind: "crash",
      source: "browser-error",
      message: `the page shell handed over a malformed report: ${parsed.error.message}`,
      url: window.location.href,
      userAgent: navigator.userAgent,
      data: { errorType: "ShellReportMalformed", stack: null },
    });
    return;
  }
  const { clientId, buildId: _buildId, commit: _commit, ...rest } = parsed.data;
  void report({ ...rest, ...(clientId == null ? {} : { clientId }) });
}

/**
 * Take over the shell's report queue (`SHELL_REPORT_QUEUE_GLOBAL`): report
 * what it holds, then report every later push at once. Returns the release,
 * which puts an empty queue back so a push after it waits for the next taker
 * (a StrictMode remount).
 */
export function takeShellReports(): () => void {
  const pending: unknown = Reflect.get(globalThis, SHELL_REPORT_QUEUE_GLOBAL);
  const taker = { push: deliver };
  Reflect.set(globalThis, SHELL_REPORT_QUEUE_GLOBAL, taker);
  if (Array.isArray(pending)) for (const body of pending) deliver(body);
  return () => {
    if (Reflect.get(globalThis, SHELL_REPORT_QUEUE_GLOBAL) === taker) {
      Reflect.set(globalThis, SHELL_REPORT_QUEUE_GLOBAL, []);
    }
  };
}
