import { describe, expect, test } from "bun:test";
import type { BootEvent } from "@plugins/debug/plugins/boot-events/server";
import {
  classifyNeverReady,
  isSettledVerdict,
  type FleetEntry,
} from "./classify-wedge";

const T0 = Date.parse("2026-11-04T22:00:05.000Z");
const BUDGET = 120_000;
const KILLED =
  "backend spawn failed: readiness timeout: still not ready 1m30s after escalation (answered HTTP: true)";

const boot = (over: Partial<BootEvent> = {}): BootEvent => ({
  worktree: "wt-a",
  processStartedAt: T0,
  readyAt: null,
  exitedAt: null,
  deadBy: null,
  supersededAtMs: null,
  ...over,
});
const fleet = (state: string, lastSpawnErr = "") =>
  new Map<string, FleetEntry>([["wt-a", { state, lastSpawnErr }]]);
const at = (ms: number) => T0 + ms;

describe("classifyNeverReady", () => {
  test("nothing to report: ready, exited, within budget, unreadable or torn-down fleet", () => {
    expect(
      classifyNeverReady(
        boot({ readyAt: at(5000) }),
        fleet("running"),
        at(600_000),
        BUDGET,
      ),
    ).toBeNull();
    expect(
      classifyNeverReady(
        boot({ exitedAt: at(3000) }),
        fleet("broken"),
        at(600_000),
        BUDGET,
      ),
    ).toBeNull();
    expect(
      classifyNeverReady(boot(), fleet("starting"), at(60_000), BUDGET),
    ).toBeNull();
    // Settled dead — already reported: not re-filed, whatever the fleet says
    // (a main restart reads the same line).
    for (const state of ["idle", "broken", "running"])
      expect(
        classifyNeverReady(
          boot({ deadBy: at(200_000) }),
          fleet(state, KILLED),
          at(90_000_000),
          BUDGET,
        ),
      ).toBeNull();
    expect(
      classifyNeverReady(
        boot({ deadBy: at(300_000), supersededAtMs: at(300_000) }),
        fleet("running"),
        at(600_000),
        BUDGET,
      ),
    ).toBeNull();
    expect(classifyNeverReady(boot(), null, at(600_000), BUDGET)).toBeNull();
    expect(
      classifyNeverReady(boot(), new Map(), at(600_000), BUDGET),
    ).toBeNull();
  });

  test("the gateway still waiting on it: booting", () => {
    expect(
      classifyNeverReady(boot(), fleet("starting"), at(150_000), BUDGET),
    ).toEqual({
      state: "booting",
      wedgedMs: 150_000,
      fleetState: "starting",
    });
  });

  // The 2026-11-04 lie: a boot the gateway SIGKILLed at its deadline, still
  // filed every minute as "un-ready 113592s and still live".
  test("killed at the deadline, no backend running: failed, quoting the gateway", () => {
    expect(
      classifyNeverReady(
        boot(),
        fleet("broken", KILLED),
        at(31 * 3600_000),
        BUDGET,
      ),
    ).toEqual({
      state: "failed",
      wedgedMs: 31 * 3600_000,
      fleetState: "broken",
      gatewayError: KILLED,
    });
    // After a gateway restart (or the idle sweeper) it holds no failure and
    // would boot it on the next request: a past fact, not "unusable".
    expect(
      classifyNeverReady(boot(), fleet("idle"), at(600_000), BUDGET)?.state,
    ).toBe("killed");
    expect(
      classifyNeverReady(boot(), fleet("stopping"), at(600_000), BUDGET)?.state,
    ).toBe("killed");
  });

  test("a backend serves: the never-ready boot was a failed hot restart", () => {
    expect(
      classifyNeverReady(boot(), fleet("running", KILLED), at(200_000), BUDGET)
        ?.state,
    ).toBe("restart-failed");
  });

  test("a later attempt replaced it: superseded, needing no fleet", () => {
    expect(
      classifyNeverReady(
        boot({ supersededAtMs: at(140_000) }),
        null,
        at(900_000),
        BUDGET,
      ),
    ).toEqual({
      state: "superseded",
      wedgedMs: 140_000,
      supersededAtMs: at(140_000),
    });
  });

  test("every verdict but booting settles the boot (its process is gone)", () => {
    const states = ["starting", "running", "broken", "idle", "stopping"].map(
      (st) => classifyNeverReady(boot(), fleet(st), at(600_000), BUDGET),
    );
    const superseded = classifyNeverReady(
      boot({ supersededAtMs: at(400_000) }),
      fleet("running"),
      at(600_000),
      BUDGET,
    );
    expect(
      [...states, superseded].map((v) => [v!.state, isSettledVerdict(v!)]),
    ).toEqual([
      ["booting", false],
      ["restart-failed", true],
      ["failed", true],
      ["killed", true],
      ["killed", true],
      ["superseded", true],
    ]);
  });
});
