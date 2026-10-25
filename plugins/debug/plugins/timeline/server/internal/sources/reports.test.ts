import { describe, expect, test } from "bun:test";
import { mapReportRows, reportsSource, type ReportRow } from "./reports";
import type { DbSourceCtx } from "./context";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

const T0 = Date.parse("2026-07-10T09:00:00.000Z");
const ctx: DbSourceCtx = {
  dbName: "wt-a",
  isMainDb: false,
  fromMs: T0,
  toMs: T0 + 60 * 60 * 1000,
};

// A row as `RawReportRowSchema` yields it at the read boundary.
const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: "rep-1",
  worktree: "wt-a",
  kind: "crash",
  source: "server",
  message: "TypeError: undefined is not a function",
  noise: false,
  count: 3,
  trace_id: null,
  last_seen_at: new Date(T0 + 10 * 60 * 1000),
  ...over,
});

describe("mapReportRows", () => {
  test("renders a point event at lastSeenAt", () => {
    const [ev] = mapReportRows([row()], ctx);
    expect(ev!.startMs).toBe(T0 + 10 * 60 * 1000);
    expect(ev!.endMs).toBe(ev!.startMs);
    expect(ev!.source).toBe("report");
    expect(ev!.label).toBe("TypeError: undefined is not a function");
    expect(ev!.detail).toEqual({
      kind: "crash",
      reportSource: "server",
      count: 3,
      noise: false,
    });
  });

  test("crash-like kinds are errors, monitor kinds warnings, noise info", () => {
    expect(mapReportRows([row()], ctx)[0]!.severity).toBe("error");
    expect(
      mapReportRows([row({ kind: "queue-backlog" })], ctx)[0]!.severity,
    ).toBe("warning");
    expect(mapReportRows([row({ noise: true })], ctx)[0]!.severity).toBe(
      "info",
    );
  });

  test("traceId comes from data->>'traceId' when present", () => {
    expect(mapReportRows([row()], ctx)[0]!.traceId).toBeUndefined();
    expect(mapReportRows([row({ trace_id: "tr-4" })], ctx)[0]!.traceId).toBe(
      "tr-4",
    );
  });
});

describe("reportsSource.build", () => {
  test("bounds lastSeenAt to the window; forks scope to their worktree", () => {
    const fork = reportsSource.build(ctx);
    expect(fork.text).toContain("last_seen_at >=");
    expect(fork.text).toContain("last_seen_at <=");
    expect(fork.text).toContain("AND worktree = $3");
    expect(fork.values).toEqual([T0, T0 + 60 * 60 * 1000, "wt-a"]);
    const main = reportsSource.build({
      ...ctx,
      dbName: MAIN_WORKTREE_NAME,
      isMainDb: true,
    });
    expect(main.text).not.toContain("worktree =");
  });
});
