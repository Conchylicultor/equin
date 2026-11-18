// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_REPORT_QUEUE_GLOBAL } from "../../core";

const report = vi.fn((_body: unknown) => Promise.resolve(null));
vi.mock("@plugins/reports/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  report,
}));

const { takeShellReports } = await import("../internal/shell-reports");

const body = (message: string) => ({
  kind: "crash",
  source: "plugin-load",
  message,
  url: "http://x/story",
  userAgent: "ua",
  data: { errorType: "BootModuleLoadFailed", stack: null, urls: [] },
});

/** What the shell does (index.html's `send`). */
function shellPush(b: unknown): void {
  const q = (Reflect.get(globalThis, SHELL_REPORT_QUEUE_GLOBAL) ?? []) as {
    push(b: unknown): void;
  };
  Reflect.set(globalThis, SHELL_REPORT_QUEUE_GLOBAL, q);
  q.push(b);
}

describe("takeShellReports", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, SHELL_REPORT_QUEUE_GLOBAL);
    report.mockClear();
  });

  it("reports what the shell queued before it, then every later push at once", () => {
    shellPush(body("early"));
    const release = takeShellReports();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({ message: "early" });
    shellPush(body("late"));
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toMatchObject({ message: "late" });
    release();
  });

  it("queues again once released, for the next taker", () => {
    takeShellReports()();
    shellPush(body("between"));
    expect(report).not.toHaveBeenCalled();
    takeShellReports();
    expect(report.mock.calls[0]![0]).toMatchObject({ message: "between" });
  });

  it("files a malformed body as a crash of its own", () => {
    takeShellReports();
    shellPush({ kind: "crash" });
    expect(report.mock.calls[0]![0]).toMatchObject({
      data: { errorType: "ShellReportMalformed" },
    });
  });
});
