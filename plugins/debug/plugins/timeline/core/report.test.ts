import { describe, expect, test } from "bun:test";
import {
  formatTimelineEvent,
  formatTimelineHeader,
  readTimelineReport,
  timelineHeading,
} from "./report";

// A trimmed real get_timeline answer (2026-10-31 incident), including a
// multi-line slow-SQL label.
const REAL = [
  "TIMELINE  2026-10-31 15:26:00 → 2026-10-31 15:40:00  (Europe/Paris)",
  "window 14m 00s · scanned 500 chunks · 1039 events · 4 duress · 7 health lanes · 5 chunk errors",
  "",
  "DURESS  (host-global — signal is thinned inside these)",
  "  15:26:25.363 → 15:27:20.364 (55.0s)  cluster-onset: slowBackends",
  "",
  "HOST PRESSURE (peak)",
  "  score 8.79 [error]  @ 15:34:14.124  load 305.35/18cpu  decomp 17815/s  swap 0/s",
  "",
  "BACKEND HEALTH (peak event-loop p99)",
  "  att-1793454888-jhj2f0  peak p99 95227ms @ 15:35:06.411  phys 414MB",
  "",
  "EVENTS",
  "  15:33:10.279 [ERROR] slow-op  att-1793454888-jhj2f0  bg git-watcher:recompute  trace=822a3837-8b79-45fc-90f3-5a81bda5190f",
  "  15:35:09.364 [ERROR] slow-op  att-1793455048-ze97b5  db ",
  "      INSERT INTO live_state_snapshot AS s",
  "        (resource_key, params_key)",
  "  15:36:00.000 [WARN ] report  main  Slow operation detected",
  "  dropped (raise minSeverity / narrow window): slow-op 12 info",
  "",
  "CHUNK ERRORS (data missing here)",
  "  none",
].join("\n");

describe("readTimelineReport", () => {
  test("reads a real report", () => {
    const read = readTimelineReport(REAL);
    expect(read.kind).toBe("report");
    if (read.kind !== "report") return;
    const r = read.report;
    expect([r.from, r.to, r.tz]).toEqual([
      "2026-10-31 15:26:00",
      "2026-10-31 15:40:00",
      "Europe/Paris",
    ]);
    expect(r.window).toBe("14m 00s");
    expect([
      r.scanned,
      r.events,
      r.duress,
      r.healthLanes,
      r.chunkErrors,
    ]).toEqual([500, 1039, 4, 7, 5]);
    expect(r.sections.map((s) => s.id)).toEqual([
      "duress",
      "host-pressure",
      "backend-health",
      "events",
      "chunk-errors",
    ]);
    expect(r.shown.map((e) => [e.severity, e.source, e.worktree])).toEqual([
      ["error", "slow-op", "att-1793454888-jhj2f0"],
      ["error", "slow-op", "att-1793455048-ze97b5"],
      ["warning", "report", "main"],
    ]);
    expect(r.shown[0]!.traceId).toBe("822a3837-8b79-45fc-90f3-5a81bda5190f");
    expect(r.shown[0]!.label).toBe("bg git-watcher:recompute");
    expect(r.shown[1]!.label).toContain("INSERT INTO live_state_snapshot");
    expect(r.dropped).toBe(
      "dropped (raise minSeverity / narrow window): slow-op 12 info",
    );
  });

  test("round-trips the format functions", () => {
    const text = [
      ...formatTimelineHeader({
        from: "a",
        to: "b",
        tz: "UTC",
        window: "1m 00s",
        scanned: 3,
        events: 1,
        duress: 0,
        healthLanes: 0,
        chunkErrors: 0,
      }),
      "",
      timelineHeading("events"),
      formatTimelineEvent({
        time: "10:00:00.000",
        severity: "info",
        source: "build",
        worktree: "w",
        label: "built",
      }),
    ].join("\n");
    const read = readTimelineReport(text);
    expect(read.kind === "report" && read.report.shown[0]?.label).toBe("built");
  });

  test("a failure message is unreadable", () => {
    expect(readTimelineReport("The operation timed out.")).toEqual({
      kind: "unreadable",
    });
  });
});
