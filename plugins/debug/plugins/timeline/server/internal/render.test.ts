import { describe, expect, test } from "bun:test";
import type { TimelineEvent, TimelineSeverity } from "../../core";
import { HOST_LANE, type TimelineFrame } from "../../shared/frames";
import { renderTimeline, type RenderOpts } from "./render";

// Fixed window: 2026-07-17 13:00:00 UTC .. +20 min. UTC pins the local-time
// assertions regardless of host TZ.
const T = Date.UTC(2026, 6, 17, 13, 0, 0, 0);
const TO = T + 20 * 60_000;

const OPTS: RenderOpts = {
  fromMs: T,
  toMs: TO,
  minSeverity: "info",
  maxEvents: 4,
  cpuCount: 10,
  tz: "UTC",
};

function ev(
  source: TimelineEvent["source"],
  worktree: string,
  startMs: number,
  severity: TimelineSeverity,
  extra: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id: `${source}:${worktree}:${startMs}`,
    source,
    worktree,
    startMs,
    endMs: startMs,
    label: `${source} on ${worktree}`,
    severity,
    detail: {},
    ...extra,
  };
}

// A synthetic frame stream exercising every section.
function buildFrames(): TimelineFrame[] {
  const frames: TimelineFrame[] = [];
  frames.push({ total: 20 });

  // EVENTS: 3 errors, 2 warnings, 50 info — floods info to prove severity-first
  // retention keeps the errors/warnings under a small maxEvents.
  const errs = [
    ev("trace", "att-a", T + 10_000, "error", { traceId: "tr-1", label: "err-early" }),
    ev("trace", "att-a", T + 20_000, "error", { label: "err-mid" }),
    ev("trace", "att-b", T + 30_000, "error", { label: "err-late" }),
  ];
  const warns = [
    ev("report", "att-a", T + 15_000, "warning", { label: "warn-older" }),
    ev("report", "att-b", T + 25_000, "warning", { label: "warn-newer" }),
  ];
  const infos: TimelineEvent[] = [];
  for (let i = 0; i < 50; i++) infos.push(ev("slow-op", "att-a", T + 1_000 + i * 100, "info"));
  frames.push({ chunk: { source: "trace", worktree: "att-a", ok: true, events: [...errs, ...warns, ...infos] } });

  // DURESS (host-global chunk): one paired episode (5m) + one in-flight.
  frames.push({
    chunk: {
      source: "duress",
      worktree: HOST_LANE,
      ok: true,
      events: [
        {
          id: "duress:paired",
          source: "duress",
          worktree: HOST_LANE,
          startMs: T + 300_000,
          endMs: T + 600_000,
          label: "duress: compressor thrash",
          severity: "warning",
          detail: { reason: "compressor thrash", episodeSetAt: T + 300_000, clearedAtMs: T + 600_000 },
        },
        {
          id: "duress:open",
          source: "duress",
          worktree: HOST_LANE,
          startMs: T + 700_000,
          endMs: TO,
          label: "duress: still hot",
          severity: "warning",
          detail: { reason: "still hot", episodeSetAt: T + 700_000, open: true, endUnknown: false, inFlight: true },
        },
      ],
    },
  });

  // HOST PRESSURE: a compressor spike at T+200s.
  frames.push({
    health: {
      worktree: HOST_LANE,
      samples: [
        { atMs: T + 100_000, loadAvg1: 2, decompPerSec: 1_000, swap: 0 },
        { atMs: T + 200_000, loadAvg1: 20, decompPerSec: 300_000, swap: 0 },
      ],
    },
  });

  // BACKEND HEALTH: att-a peaks above warning, att-b stays below.
  frames.push({
    health: { worktree: "att-a", samples: [{ atMs: T + 40_000, p99Ms: 800, physMb: 512 }] },
  });
  frames.push({
    health: { worktree: "att-b", samples: [{ atMs: T + 40_000, p99Ms: 50, physMb: 128 }] },
  });

  // CHUNK ERRORS: one worktree, all four DB sources fail with the same message.
  for (const source of ["trace", "slow-op", "report", "build"] as const) {
    frames.push({ chunk: { source, worktree: "att-x", ok: false, error: "session open failed" } });
  }
  frames.push({ end: true });
  return frames;
}

describe("renderTimeline", () => {
  const out = renderTimeline(buildFrames(), OPTS);
  const lines = out.split("\n");

  test("header carries local window + tz + scanned counts", () => {
    expect(lines[0]).toBe("TIMELINE  2026-07-17 13:00:00 → 2026-07-17 13:20:00  (UTC)");
    expect(out).toContain("scanned 20 chunks");
    expect(out).toContain("2 duress");
    expect(out).toContain("4 chunk errors");
  });

  test("sections appear DURESS → HOST PRESSURE → BACKEND HEALTH → EVENTS → CHUNK ERRORS", () => {
    const order = ["DURESS", "HOST PRESSURE", "BACKEND HEALTH", "EVENTS", "CHUNK ERRORS"].map((s) =>
      out.indexOf(s),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
  });

  test("DURESS renders every episode, never capped, paired duration + in-flight", () => {
    expect(out).toContain("13:05:00.000 → 13:10:00.000 (5m 00s)  compressor thrash");
    expect(out).toContain("13:11:40.000 → in-flight  still hot");
  });

  test("HOST PRESSURE reports the peak score/bucket/time and rates", () => {
    expect(out).toContain("score 3.20 [error]");
    expect(out).toContain("@ 13:03:20.000");
    expect(out).toContain("decomp 300000/s");
  });

  test("BACKEND HEALTH lists above-warning lanes and collapses the rest", () => {
    expect(out).toContain("att-a  peak p99 800ms @ 13:00:40.000  phys 512MB");
    expect(out).toContain("… 1 lanes below warning omitted");
    expect(out).not.toContain("att-b  peak p99");
  });

  test("severity-first retention keeps errors/warnings, drops all info under the cap", () => {
    const eventsBlock = out.slice(out.indexOf("EVENTS"), out.indexOf("CHUNK ERRORS"));
    // maxEvents=4 → 3 errors + the 1 most-recent warning; no info survives.
    expect(eventsBlock).not.toContain("[INFO ]");
    expect(eventsBlock).toContain("warn-newer");
    expect(eventsBlock).not.toContain("warn-older");
    expect((eventsBlock.match(/\[ERROR\]/g) ?? []).length).toBe(3);
  });

  test("kept events are re-sorted by wall clock, with inline trace id", () => {
    const eventsBlock = out.slice(out.indexOf("EVENTS"), out.indexOf("CHUNK ERRORS"));
    const rows = eventsBlock.split("\n").filter((l) => /\[(ERROR|WARN )\]/.test(l));
    expect(rows.map((r) => r.match(/err-\w+|warn-\w+/)?.[0])).toEqual([
      "err-early",
      "err-mid",
      "warn-newer",
      "err-late",
    ]);
    expect(rows[0]).toContain("trace=tr-1");
  });

  test("drop accounting is explicit and exact, grouped by source+severity", () => {
    // 50 info (all capped) + 1 warning (warn-older, capped). No silent caps.
    expect(out).toContain("dropped (raise minSeverity / narrow window): slow-op 50 info, report 1 warning");
  });

  test("chunk errors group a worktree's sources", () => {
    expect(out).toContain(
      "att-x  trace, slow-op, report, build: session open failed",
    );
  });
});

describe("renderTimeline empty/quiet window", () => {
  const out = renderTimeline([{ total: 0 }, { end: true }], OPTS);

  test("every section states its emptiness — missing data never reads as calm", () => {
    expect(out).toContain("DURESS");
    expect(out).toContain("none in window");
    expect(out).toContain("no host health samples in window");
    expect(out).toContain("no backend health samples in window");
    expect(out).toContain("none in window at this severity");
    // CHUNK ERRORS with nothing wrong says "none" explicitly.
    const chunkBlock = out.slice(out.indexOf("CHUNK ERRORS"));
    expect(chunkBlock).toContain("none");
  });
});

describe("renderTimeline minSeverity gate", () => {
  test("below-minSeverity events are dropped from the list but still counted", () => {
    const frames: TimelineFrame[] = [
      { total: 1 },
      {
        chunk: {
          source: "slow-op",
          worktree: "att-a",
          ok: true,
          events: [ev("slow-op", "att-a", T + 1_000, "info"), ev("trace", "att-a", T + 2_000, "error")],
        },
      },
      { end: true },
    ];
    const out = renderTimeline(frames, { ...OPTS, minSeverity: "warning", maxEvents: 200 });
    const eventsBlock = out.slice(out.indexOf("EVENTS"), out.indexOf("CHUNK ERRORS"));
    expect(eventsBlock).toContain("[ERROR]");
    expect(eventsBlock).not.toContain("[INFO ]");
    expect(out).toContain("dropped (raise minSeverity / narrow window): slow-op 1 info");
  });
});
