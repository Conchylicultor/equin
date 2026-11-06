/**
 * The health report's Job queue row, driven through its real hooks with the
 * live-state reads stubbed: what `useStatus` says for a closed socket, a load
 * in flight, a load error and a pushed pulse; how the glance draws busy,
 * forfeited and tinted slots (and nothing, rather than an empty queue, when it
 * cannot read one); and that the detail names only the jobs behind the colour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LiveStateWeb from "@plugins/network/plugins/live/plugins/live-state/web";

// Mounting live-state otherwise schedules real log flushes at module eval —
// the convention the live-state hazard suites established.
vi.mock(
  "@plugins/primitives/plugins/log-channels/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    clientLog: () => {},
  }),
);

const live = vi.hoisted(() => ({
  socket: "open" as "connecting" | "open" | "reconnecting" | "closed",
  result: undefined as unknown,
}));

// The row's status reads the verdict value, the glance and detail the full
// pulse: one stubbed pulse serves both, the verdict read as its `verdict`.
vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => {
  const core = await import("../../core");
  return {
    ...(await importOriginal<object>()),
    useLive: (decl: unknown) => {
      const r = live.result as { status: string; data?: { verdict: unknown } };
      return decl === core.queueVerdictValue && r.status === "ready"
        ? { ...r, data: r.data?.verdict }
        : r;
    },
  };
});

vi.mock(
  "@plugins/network/plugins/live/plugins/live-state/web",
  async (importOriginal) => ({
    ...(await importOriginal<typeof LiveStateWeb>()),
    useNotificationsChannelStatuses: () => ({
      worktree: live.socket,
      central: "open",
    }),
  }),
);

import { cleanup, render, renderHook } from "@testing-library/react";
import {
  HOLD_CLASSES,
  reachableSlots,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";
import type { QueueClassPulse, QueuePulse, QueueTone } from "../../core";
import { useQueueHealth } from "../internal/use-queue-health";
import { QueueGlance } from "../components/queue-glance";
import { QueueDetail } from "../components/queue-detail";

const NOW = Date.now();
const refetch = () => Promise.resolve();

function settled(pulse: QueuePulse) {
  live.result = { status: "ready", data: pulse, refetch };
}
function pending(error: Error | null) {
  live.result =
    error === null
      ? { status: "loading", refetch }
      : {
          status: "error",
          error: new ResourceError("loader-failed", error.message, error),
          refetch,
        };
}

function classPulse(
  hold: HoldClass,
  extra: Partial<QueueClassPulse> = {},
): QueueClassPulse {
  const reachable = reachableSlots(hold);
  return {
    hold,
    reachable,
    usable: reachable,
    busy: 0,
    forfeited: 0,
    waiting: 0,
    oldestWaitingRunAt: null,
    behindLanes: 0,
    pickup: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
    ...extra,
  };
}

function pulse(partial: Partial<QueuePulse> = {}): QueuePulse {
  return {
    classes: HOLD_CLASSES.map((hold) => classPulse(hold)),
    running: [],
    oldestWaiting: [],
    dead: [],
    orphanLocked: 0,
    pickupWindowMs: 15 * 60_000,
    verdict: {
      state: "ok",
      summary: "Idle",
      cause: Object.fromEntries(HOLD_CLASSES.map((h) => [h, "ok"])) as Record<
        HoldClass,
        QueueTone
      >,
    },
    ...partial,
  };
}

beforeEach(() => {
  live.socket = "open";
  pending(null);
});
afterEach(cleanup);

describe("useStatus", () => {
  it("is unknown, and says why, while the server socket is down", () => {
    settled(pulse());
    for (const socket of ["closed", "reconnecting"] as const) {
      live.socket = socket;
      const { result } = renderHook(() => useQueueHealth());
      // A cached pulse must not keep claiming a state nobody can refresh.
      expect(result.current).toEqual({
        state: "unknown",
        summary: "Unknown while disconnected",
      });
    }
  });

  it("is pending (no summary) while the first connection is made", () => {
    live.socket = "connecting";
    const { result } = renderHook(() => useQueueHealth());
    expect(result.current).toEqual({ state: "unknown" });
  });

  it("is pending (no summary) while the pulse loads", () => {
    pending(null);
    const { result } = renderHook(() => useQueueHealth());
    expect(result.current).toEqual({ state: "unknown" });
  });

  it("is unknown with a reason when the load failed", () => {
    pending(new Error("boom"));
    const { result } = renderHook(() => useQueueHealth());
    expect(result.current).toEqual({
      state: "unknown",
      summary: "Could not read the queue",
    });
  });

  it("is the server's verdict once a pulse arrives", () => {
    settled(
      pulse({
        verdict: {
          state: "attention",
          summary: "backup.run stuck 30m+",
          cause: { instant: "ok", seconds: "ok", minutes: "attention" },
        },
      }),
    );
    const { result } = renderHook(() => useQueueHealth());
    expect(result.current).toEqual({
      state: "attention",
      summary: "backup.run stuck 30m+",
    });
  });
});

function bar(hold: HoldClass): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-queue-class="${hold}"]`,
  );
  if (!el) throw new Error(`no bar for ${hold}`);
  return el;
}
function segments(hold: HoldClass): string[] {
  return [...bar(hold).querySelectorAll<HTMLElement>("[data-segment]")].map(
    (s) => s.dataset.segment!,
  );
}

describe("the glance", () => {
  it("draws one segment per reachable slot: busy from the left, forfeited from the right", () => {
    settled(
      pulse({
        classes: HOLD_CLASSES.map((hold) =>
          hold === "instant"
            ? classPulse(hold, { busy: 3, forfeited: 1, usable: 7 })
            : classPulse(hold),
        ),
      }),
    );
    render(<QueueGlance />);
    const reach = reachableSlots("instant");
    expect(segments("instant")).toEqual([
      "busy",
      "busy",
      ...Array<string>(reach - 3).fill("free"),
      "forfeited",
    ]);
    expect(bar("instant").textContent).toContain(`3/${reach}`);
  });

  it("tints only the class that coloured the row", () => {
    const minutes = reachableSlots("minutes");
    settled(
      pulse({
        classes: HOLD_CLASSES.map((hold) =>
          hold === "minutes"
            ? classPulse(hold, { busy: minutes })
            : classPulse(hold, { busy: 1 }),
        ),
        verdict: {
          state: "attention",
          summary: "Minutes class full · 1 job waiting 10m+",
          cause: { instant: "ok", seconds: "ok", minutes: "attention" },
        },
      }),
    );
    render(<QueueGlance />);
    expect(bar("minutes").dataset.tone).toBe("attention");
    const busy = bar("minutes").querySelector("[data-segment='busy']")!;
    expect(busy.className).toContain("bg-warning");
    expect(bar("instant").dataset.tone).toBe("ok");
    expect(
      bar("instant").querySelector("[data-segment='busy']")!.className,
    ).not.toContain("bg-warning");
  });

  it("draws the bars unfilled with a dash when the queue cannot be read — never as an empty queue", () => {
    live.socket = "closed";
    render(<QueueGlance />);
    for (const hold of HOLD_CLASSES) {
      expect(segments(hold)).toEqual(
        Array<string>(reachableSlots(hold)).fill("unknown"),
      );
      expect(bar(hold).textContent).toContain("–");
      expect(bar(hold).textContent).not.toContain("0/");
    }
  });
});

function items(): { kind: string; text: string }[] {
  return [...document.querySelectorAll<HTMLElement>("[data-queue-item]")].map(
    (el) => ({ kind: el.dataset.queueItem!, text: el.textContent }),
  );
}

describe("the detail", () => {
  const running = (jobId: string, stuck: boolean) => ({
    jobId,
    jobName: `run-${jobId}`,
    hold: "minutes" as const,
    runnerId: "wide",
    lockedAt: NOW - 60_000,
    stuck,
    forfeited: false,
  });

  it("names only the jobs behind the colour when the row is not green", () => {
    settled(
      pulse({
        classes: HOLD_CLASSES.map((hold) =>
          hold === "seconds"
            ? classPulse(hold, { waiting: 3 })
            : classPulse(hold),
        ),
        running: [running("a", true), running("b", false), running("c", false)],
        oldestWaiting: [
          {
            jobId: "w1",
            jobName: "late",
            hold: "seconds",
            runAt: NOW - 200_000,
            attempts: 0,
            tone: "attention",
          },
          {
            jobId: "w2",
            jobName: "fresh",
            hold: "seconds",
            runAt: NOW - 10,
            attempts: 0,
            tone: "ok",
          },
        ],
        dead: [
          {
            jobName: "worktree.fork-db",
            count: 3,
            lastDiedAt: NOW - 60_000,
            lastError: "x",
            recent: true,
          },
          {
            jobName: "old.death",
            count: 1,
            lastDiedAt: NOW - 5 * 3_600_000,
            lastError: null,
            recent: false,
          },
        ],
        verdict: {
          state: "attention",
          summary: "Seconds: 3 jobs waiting, oldest 1m 40s+",
          cause: { instant: "ok", seconds: "attention", minutes: "attention" },
        },
      }),
    );
    render(<QueueDetail />);
    const listed = items();
    expect(listed.map((i) => i.kind)).toEqual(["dead", "waiting", "running"]);
    expect(listed[0]!.text).toContain("worktree.fork-db");
    expect(listed[0]!.text).toContain("failed ×3");
    expect(listed[1]!.text).toContain("late");
    expect(listed[2]!.text).toContain("run-a");
    expect(listed[2]!.text).toContain("stuck");
    const text = document.body.textContent;
    expect(text).not.toContain("run-b");
    expect(text).not.toContain("fresh");
    expect(text).not.toContain("old.death");
    expect(text).toContain("+ 2 more running · + 2 more waiting");
  });

  it("lists what is running when the row is green", () => {
    settled(
      pulse({
        running: [running("a", false), running("b", false)],
        verdict: {
          state: "ok",
          summary: "2 running · nothing waiting",
          cause: { instant: "ok", seconds: "ok", minutes: "ok" },
        },
      }),
    );
    render(<QueueDetail />);
    expect(items().map((i) => i.kind)).toEqual(["running", "running"]);
    expect(document.body.textContent).not.toContain("more running");
  });

  it("says 'no pickups' rather than 0 ms for a class with no samples, and tints a slow p95", () => {
    settled(
      pulse({
        classes: HOLD_CLASSES.map((hold) =>
          hold === "instant"
            ? classPulse(hold, {
                pickup: { count: 4, p50Ms: 12, p95Ms: 5_000, maxMs: 6_200 },
              })
            : classPulse(hold),
        ),
      }),
    );
    render(<QueueDetail />);
    const line = (hold: HoldClass) =>
      document.querySelector<HTMLElement>(`[data-queue-pickup="${hold}"]`)!;
    expect(line("instant").textContent).toContain("p50 12ms");
    expect(line("instant").textContent).toContain("p95 5s");
    expect(line("instant").innerHTML).toContain("text-warning");
    expect(line("seconds").textContent).toContain("no pickups in the last 15m");
    expect(line("seconds").textContent).not.toContain("0ms");
  });
});
