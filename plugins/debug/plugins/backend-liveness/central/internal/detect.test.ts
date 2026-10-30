import { describe, expect, test } from "bun:test";
import { FROZEN_AFTER_MS, HEARTBEAT_MS, PROBE_EVERY_MS } from "../../core";
import { createLivenessDetector, type Observation } from "./detect";

const T0 = 1_800_000_000_000;

function obs(result: Observation["result"], pid = 42): Observation[] {
  return [{ worktree: "wt", pid, result }];
}

/** Run `n` ticks at the normal cadence starting at `from`, returning all lines. */
function run(
  d: ReturnType<typeof createLivenessDetector>,
  from: number,
  n: number,
  result: Observation["result"],
) {
  const lines = [];
  for (let i = 0; i < n; i++)
    lines.push(
      ...d.step({
        atMs: from + i * PROBE_EVERY_MS,
        suspended: false,
        observations: obs(result),
      }),
    );
  return lines;
}

describe("liveness detector", () => {
  test("a backend that stops answering is frozen once FROZEN_AFTER_MS of awake time passed", () => {
    const d = createLivenessDetector();
    const ticksToFreeze = FROZEN_AFTER_MS / PROBE_EVERY_MS;
    // First miss starts the streak; it takes `ticksToFreeze` more to cross.
    expect(run(d, T0, ticksToFreeze, "unanswered")).toEqual([]);
    const lines = run(d, T0 + ticksToFreeze * PROBE_EVERY_MS, 1, "unanswered");
    expect(lines).toEqual([
      {
        worktree: "wt",
        pid: 42,
        sinceMs: T0,
        unansweredMs: FROZEN_AFTER_MS,
        state: "frozen",
        observedMs: T0 + FROZEN_AFTER_MS,
      },
    ]);
  });

  test("an open episode heartbeats once per HEARTBEAT_MS, then closes when it answers", () => {
    const d = createLivenessDetector();
    const ticks = (FROZEN_AFTER_MS + HEARTBEAT_MS) / PROBE_EVERY_MS + 1;
    const lines = run(d, T0, ticks, "unanswered");
    expect(lines.map((l) => l.state)).toEqual(["frozen", "frozen"]);
    const closed = run(d, T0 + ticks * PROBE_EVERY_MS, 1, "answered");
    expect(closed).toEqual([
      expect.objectContaining({ state: "answered", sinceMs: T0 }),
    ]);
    // Closed: a later answer writes nothing.
    expect(run(d, T0 + (ticks + 1) * PROBE_EVERY_MS, 1, "answered")).toEqual(
      [],
    );
  });

  test("a short stall that answers before the threshold writes nothing", () => {
    const d = createLivenessDetector();
    expect(run(d, T0, 3, "unanswered")).toEqual([]);
    expect(run(d, T0 + 3 * PROBE_EVERY_MS, 1, "answered")).toEqual([]);
  });

  test("machine sleep never counts: a long gap between ticks adds no unanswered time", () => {
    const d = createLivenessDetector();
    run(d, T0, 2, "unanswered");
    // The machine slept 2 h; the probe in flight timed out on wake.
    const lines = d.step({
      atMs: T0 + 2 * 3_600_000,
      suspended: false,
      observations: obs("unanswered"),
    });
    expect(lines).toEqual([]);
    // A suspended tick (its own probe spanned the sleep) adds nothing either.
    expect(
      d.step({
        atMs: T0 + 2 * 3_600_000 + PROBE_EVERY_MS,
        suspended: true,
        observations: obs("unanswered"),
      }),
    ).toEqual([]);
  });

  test("a paused (SIGSTOPped) backend is never frozen", () => {
    const d = createLivenessDetector();
    expect(run(d, T0, 40, "paused")).toEqual([]);
  });

  test("an open episode closes as paused / exited", () => {
    for (const end of ["paused", "exited"] as const) {
      const d = createLivenessDetector();
      const ticks = FROZEN_AFTER_MS / PROBE_EVERY_MS + 1;
      run(d, T0, ticks, "unanswered");
      expect(run(d, T0 + ticks * PROBE_EVERY_MS, 1, end)).toEqual([
        expect.objectContaining({ state: end }),
      ]);
    }
  });

  test("a frozen backend the gateway no longer runs closes as exited", () => {
    const d = createLivenessDetector();
    const ticks = FROZEN_AFTER_MS / PROBE_EVERY_MS + 1;
    run(d, T0, ticks, "unanswered");
    expect(
      d.step({
        atMs: T0 + ticks * PROBE_EVERY_MS,
        suspended: false,
        observations: [],
      }),
    ).toEqual([expect.objectContaining({ state: "exited" })]);
  });

  test("an unreadable fleet observes nothing: the interval after it does not count", () => {
    const d = createLivenessDetector();
    run(d, T0, 3, "unanswered");
    d.step({ atMs: T0 + 3 * PROBE_EVERY_MS, observations: null });
    // Two more ticks: only the interval between them counts (15 s), so the
    // streak is at 2 × 15 + 15 = 45 s, below the threshold.
    expect(run(d, T0 + 4 * PROBE_EVERY_MS, 2, "unanswered")).toEqual([]);
  });

  test("a backend not listening yet (booting) is not judged", () => {
    const d = createLivenessDetector();
    expect(run(d, T0, 40, "unserved")).toEqual([]);
  });

  test("an unjudged tick (no pid sidecar, slow ps) keeps an open episode open", () => {
    const d = createLivenessDetector();
    const ticks = FROZEN_AFTER_MS / PROBE_EVERY_MS + 1;
    run(d, T0, ticks, "unanswered");
    expect(
      d.step({
        atMs: T0 + ticks * PROBE_EVERY_MS,
        suspended: false,
        observations: [{ worktree: "wt", pid: -1, result: "unknown" }],
      }),
    ).toEqual([]);
    expect(run(d, T0 + (ticks + 1) * PROBE_EVERY_MS, 1, "answered")).toEqual([
      expect.objectContaining({ state: "answered", sinceMs: T0 }),
    ]);
  });
});
