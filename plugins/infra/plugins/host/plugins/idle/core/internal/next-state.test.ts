import { describe, expect, test } from "bun:test";
import {
  IDLE_SUSTAIN_MS,
  nextIdleState,
  type BlockerReading,
  type HostIdleRecord,
} from "./next-state";

const T0 = Date.parse("2026-11-11T10:00:00Z");
const MIN = 60_000;

const quiet = (
  id: string,
  recheckAt: number | null = null,
): BlockerReading => ({
  id,
  busy: false,
  label: `${id} quiet`,
  recheckAt,
});
const busy = (id: string, recheckAt: number | null = null): BlockerReading => ({
  id,
  busy: true,
  label: `${id} busy`,
  recheckAt,
});

const BUSY: HostIdleRecord = {
  state: "busy",
  quietSince: null,
  idleSince: null,
};

describe("nextIdleState", () => {
  test("the first evaluation that finds everything quiet starts the sustain window", () => {
    const step = nextIdleState(null, [quiet("ops"), quiet("agents")], T0);
    expect(step.next).toEqual({
      state: "settling",
      quietSince: T0,
      idleSince: null,
    });
    expect(step.transition).toBeNull();
    expect(step.wakeAt).toBe(T0 + IDLE_SUSTAIN_MS);
  });

  test("no prior state and a busy blocker is busy, with nothing to wake for", () => {
    const step = nextIdleState(null, [busy("agents"), quiet("ops")], T0);
    expect(step.next).toEqual(BUSY);
    expect(step.transition).toBeNull();
    expect(step.wakeAt).toBeNull();
  });

  test("settling keeps its quietSince and becomes idle once the window has passed", () => {
    const settling = nextIdleState(BUSY, [quiet("ops")], T0).next;
    const mid = nextIdleState(settling, [quiet("ops")], T0 + 4 * MIN);
    expect(mid.next.state).toBe("settling");
    expect(mid.next.quietSince).toBe(T0);
    expect(mid.wakeAt).toBe(T0 + IDLE_SUSTAIN_MS);

    const idle = nextIdleState(mid.next, [quiet("ops")], T0 + IDLE_SUSTAIN_MS);
    expect(idle.next).toEqual({
      state: "idle",
      quietSince: T0,
      idleSince: T0 + IDLE_SUSTAIN_MS,
    });
    expect(idle.transition).toBe("began");
    expect(idle.wakeAt).toBeNull();
  });

  test("staying idle keeps idleSince and emits no transition", () => {
    const idle: HostIdleRecord = {
      state: "idle",
      quietSince: T0,
      idleSince: T0 + IDLE_SUSTAIN_MS,
    };
    const again = nextIdleState(idle, [quiet("ops")], T0 + 30 * MIN);
    expect(again.next).toEqual(idle);
    expect(again.transition).toBeNull();
  });

  test("any busy blocker ends idle", () => {
    const idle: HostIdleRecord = {
      state: "idle",
      quietSince: T0,
      idleSince: T0 + IDLE_SUSTAIN_MS,
    };
    const step = nextIdleState(
      idle,
      [quiet("ops"), busy("agents")],
      T0 + 20 * MIN,
    );
    expect(step.next).toEqual(BUSY);
    expect(step.transition).toBe("ended");
  });

  test("busy while settling restarts the window from the next quiet evaluation", () => {
    const settling = nextIdleState(BUSY, [quiet("ops")], T0).next;
    const interrupted = nextIdleState(settling, [busy("ops")], T0 + 9 * MIN);
    expect(interrupted.next).toEqual(BUSY);
    expect(interrupted.transition).toBeNull();
    const again = nextIdleState(
      interrupted.next,
      [quiet("ops")],
      T0 + 11 * MIN,
    );
    expect(again.next.quietSince).toBe(T0 + 11 * MIN);
    expect(again.next.state).toBe("settling");
  });

  test("a duress lease that lapses: busy with a recheck, then quiet with no event", () => {
    const lapse = T0 + MIN;
    const held = nextIdleState(BUSY, [quiet("ops"), busy("duress", lapse)], T0);
    expect(held.next.state).toBe("busy");
    // No event announces a lapse: the evaluation wakes itself at it.
    expect(held.wakeAt).toBe(lapse);

    const lapsed = nextIdleState(
      held.next,
      [quiet("ops"), quiet("duress")],
      lapse,
    );
    expect(lapsed.next).toEqual({
      state: "settling",
      quietSince: lapse,
      idleSince: null,
    });
    expect(lapsed.wakeAt).toBe(lapse + IDLE_SUSTAIN_MS);
  });

  test("the earliest of the sustain end and a blocker's recheck wins", () => {
    const settling = nextIdleState(BUSY, [quiet("ops")], T0).next;
    const step = nextIdleState(
      settling,
      [quiet("ops"), quiet("duress", T0 + 2 * MIN)],
      T0 + MIN,
    );
    expect(step.wakeAt).toBe(T0 + 2 * MIN);
    const later = nextIdleState(
      settling,
      [quiet("ops"), quiet("duress", T0 + 20 * MIN)],
      T0 + MIN,
    );
    expect(later.wakeAt).toBe(T0 + IDLE_SUSTAIN_MS);
  });

  test("a recheck already past is due now, never in the past", () => {
    const step = nextIdleState(BUSY, [busy("duress", T0 - MIN)], T0);
    expect(step.wakeAt).toBe(T0);
  });

  test("no blockers contributed reads as quiet", () => {
    expect(nextIdleState(BUSY, [], T0).next.state).toBe("settling");
  });
});
