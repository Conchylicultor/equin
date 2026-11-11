import { describe, expect, test } from "bun:test";
import type {
  SiteReportEntry,
  SiteReportsResponse,
} from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import {
  createReportBatcher,
  type BatchedReport,
  type BatcherLimits,
} from "./batcher";

const limits: BatcherLimits = {
  maxDistinct: 3,
  maxPosts: 4,
  maxBatch: 2,
  batchDelayMs: 5_000,
  maxBackoffMs: 60_000,
  maxFailures: 2,
};

function report(message: string): BatchedReport {
  return {
    kind: "crash",
    source: "browser-error",
    message,
    data: { errorType: "Error", stack: `Error: ${message}\n at f (a.js:1:1)` },
    path: "/",
    buildId: null,
    commit: null,
  };
}

function harness(answer: () => SiteReportsResponse | Error) {
  const sent: SiteReportEntry[][] = [];
  const timers: { fn: () => void; delayMs: number }[] = [];
  const warnings: string[] = [];
  const batcher = createReportBatcher({
    limits,
    send: (entries) => {
      sent.push(entries);
      const a = answer();
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
    schedule: (fn, delayMs) => timers.push({ fn, delayMs }),
    warn: (m) => warnings.push(m),
  });
  return { batcher, sent, timers, warnings };
}

const ok = (): SiteReportsResponse => ({
  kind: "accepted",
  accepted: 1,
  dropped: 0,
});

describe("report batcher", () => {
  test("a repeat is only counted: one entry per fingerprint, its count folded", async () => {
    const h = harness(ok);
    for (let i = 0; i < 50; i++) h.batcher.add(report("boom"));
    expect(h.timers).toHaveLength(1);
    await h.batcher.flush();
    expect(h.sent).toEqual([[{ ...report("boom"), count: 50 }]]);
    // More of it later rides the next batch as a count.
    h.batcher.add(report("boom"));
    await h.batcher.flush();
    expect(h.sent[1]).toEqual([{ ...report("boom"), count: 1 }]);
  });

  test("past maxDistinct fingerprints an occurrence is dropped on the page", async () => {
    const h = harness(ok);
    expect(["a", "b", "c", "d"].map((m) => h.batcher.add(report(m)))).toEqual([
      "batched",
      "batched",
      "batched",
      "dropped",
    ]);
    expect(h.batcher.state()).toMatchObject({ distinct: 3, droppedLocally: 1 });
  });

  test("a batch holds at most maxBatch entries; the rest go next", async () => {
    const h = harness(ok);
    for (const m of ["a", "b", "c"]) h.batcher.add(report(m));
    await h.batcher.flush();
    expect(h.sent[0]).toHaveLength(2);
    expect(h.timers.at(-1)?.delayMs).toBe(limits.batchDelayMs);
    await h.batcher.flush();
    expect(h.sent[1]).toHaveLength(1);
  });

  test("failures back off, keep their counts, and stop the visit", async () => {
    const h = harness(() => new Error("offline"));
    h.batcher.add(report("a"));
    await h.batcher.flush();
    expect(h.timers.at(-1)?.delayMs).toBe(10_000);
    await h.batcher.flush();
    expect(h.batcher.state().stopped).toBe(true);
    expect(h.sent.map((b) => b[0]!.count)).toEqual([1, 1]);
    expect(h.batcher.add(report("b"))).toBe("dropped");
    await h.batcher.flush();
    expect(h.sent).toHaveLength(2);
  });

  test("rate-limited waits what the server said", async () => {
    let first = true;
    const h = harness(() => {
      if (first) {
        first = false;
        return { kind: "rate-limited", retryAfterS: 42 };
      }
      return ok();
    });
    h.batcher.add(report("a"));
    await h.batcher.flush();
    expect(h.timers.at(-1)?.delayMs).toBe(42_000);
    await h.batcher.flush();
    expect(h.sent[1]).toEqual([{ ...report("a"), count: 1 }]);
  });

  test("never more than maxPosts POSTs a visit", async () => {
    const h = harness(ok);
    for (let i = 0; i < 10; i++) {
      h.batcher.add(report("a"));
      await h.batcher.flush();
    }
    expect(h.sent).toHaveLength(limits.maxPosts);
  });

  test("a flush asked for mid-send is not lost: pagehide sends right after", async () => {
    const sent: SiteReportEntry[][] = [];
    let release: (r: SiteReportsResponse) => void = () => undefined;
    const batcher = createReportBatcher({
      limits,
      send: (entries) => {
        sent.push(entries);
        return sent.length === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(ok());
      },
      schedule: () => undefined,
      warn: () => undefined,
    });
    batcher.add(report("a"));
    const first = batcher.flush();
    batcher.add(report("a"));
    // The page goes away while the first POST is in flight.
    await batcher.flush({ keepalive: true });
    release(ok());
    await first;
    expect(sent.map((b) => b[0]!.count)).toEqual([1, 1]);
  });
});
