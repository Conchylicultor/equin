import { describe, expect, test } from "bun:test";
import type { StallFrame, StallTab } from "../../core";
import { STALL } from "./constants";
import {
  createStallMachine,
  needsClock,
  step,
  type StallEffect,
  type StallMachine,
} from "./stall-machine";

const T0 = 1_000_000;

function tab(tabId: string, over: Partial<StallTab> = {}): StallTab {
  return {
    tabId,
    app: "agent-manager",
    routePattern: "conversation",
    url: `http://x.localhost:9000/agents/c/${tabId}`,
    visible: true,
    focused: false,
    ...over,
  };
}

function machine(): StallMachine {
  let n = 0;
  return createStallMachine({ workerId: "w1", newId: () => `inc-${++n}` });
}

function frame(startedAt: number, durationMs: number, fn = "spin"): StallFrame {
  return {
    startedAt,
    durationMs,
    blockingDurationMs: durationMs - 50,
    renderStartMs: null,
    styleAndLayoutStartMs: null,
    scripts: [
      {
        invokerType: "user-callback",
        invoker: "Window.setTimeout",
        sourceURL: "http://x/app.js",
        sourceFunctionName: fn,
        sourceCharPosition: 10,
        durationMs,
        forcedStyleAndLayoutDurationMs: 0,
        pauseDurationMs: 0,
      },
    ],
  };
}

/** Tick every second from `from` to `to` (inclusive), answering pongs for `alive` ports. */
function run(
  m: StallMachine,
  from: number,
  to: number,
  alive: string[],
): StallEffect[] {
  const out: StallEffect[] = [];
  for (let t = from; t <= to; t += STALL.PING_MS) {
    out.push(...step(m, { type: "tick", now: t }));
    for (const p of alive)
      out.push(...step(m, { type: "pong", portId: p, now: t }));
  }
  return out;
}

const of = <T extends StallEffect["type"]>(effects: StallEffect[], type: T) =>
  effects.filter(
    (e): e is Extract<StallEffect, { type: T }> => e.type === type,
  );

function attach(m: StallMachine, portId: string, t: StallTab, now = T0) {
  return step(m, { type: "attach", portId, tab: t, frozen: false, now });
}

describe("thresholds", () => {
  test("a stall opens only once the last pong is older than OPEN_AFTER_MS", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 2000, []);
    expect(m.incidents.size).toBe(0);
    run(m, T0 + 3000, T0 + 3000, []);
    expect(m.incidents.size).toBe(1);
  });

  test("a short stall that recovers is dropped (no persist, no delivery)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    const fx = run(m, T0, T0 + 3000, []);
    fx.push(...step(m, { type: "pong", portId: "a", now: T0 + 4000 }));
    expect(m.incidents.size).toBe(0);
    expect(of(fx, "persist")).toEqual([]);
    expect(of(fx, "deliver")).toEqual([]);
    expect(of(fx, "log").some((l) => l.line.kind === "near-miss")).toBe(true);
  });

  test("a recovered stall ≥ REPORT_MIN_MS waits for its LoAF entry, then files with attribution", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B", { visible: false }));
    run(m, T0, T0 + 8000, ["b"]);
    step(m, { type: "pong", portId: "a", now: T0 + 9000 });
    expect(m.outbox.size).toBe(0); // awaiting the frame
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 300, 8200),
      now: T0 + 9100,
    });
    // Filed once the settle window passed with the tab still alive.
    const fx = run(m, T0 + 10_000, T0 + 11_000, ["a", "b"]);
    const [d] = of(fx, "deliver");
    expect(d?.portId).toBe("a"); // the recovered tab files it itself
    expect(d?.payload.ended).toBe("recovered");
    expect(d?.payload.durationMs).toBe(8200);
    expect(d?.payload.startedAt).toBe(T0 + 300);
    expect(d?.payload.topFunction).toBe("spin (Window.setTimeout)");
    expect(d?.payload.framesDuring).toBe(0);
    expect(of(fx, "persist")).toHaveLength(1);
  });

  test("the LoAF entry may arrive before the pong", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 7000, []);
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 200, 7000),
      now: T0 + 7300,
    });
    // The pong right after is plain life, not a second incident.
    step(m, { type: "pong", portId: "a", now: T0 + 7400 });
    const fx = run(m, T0 + 8000, T0 + 10_000, ["a"]);
    expect(of(fx, "deliver")[0]?.payload.durationMs).toBe(7000);
    expect(of(fx, "deliver")[0]?.payload.ended).toBe("recovered");
    expect(m.incidents.size).toBe(0);
  });

  test("a hung tab whose reload terminates its script answers once, then goes: gone, attributed", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    run(m, T0, T0 + 9000, ["b"]);
    step(m, { type: "pong", portId: "a", now: T0 + 9200 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 100, 9050, "endless"),
      now: T0 + 9250,
    });
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 9300 });
    const d = of(fx, "deliver")[0]?.payload;
    expect(d?.ended).toBe("gone");
    expect(d?.topFunction).toBe("endless (Window.setTimeout)");
    expect(d?.durationMs).toBe(9050);
  });

  test("no LoAF entry within FRAME_GRACE_MS ⇒ filed unattributed on the pong measure", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 6000, []);
    step(m, { type: "pong", portId: "a", now: T0 + 7000 });
    const fx = run(m, T0 + 8000, T0 + 9000, ["a"]);
    const [d] = of(fx, "deliver");
    expect(d?.payload.topFunction).toBeNull();
    expect(d?.payload.durationMs).toBe(7000);
  });

  test("a LoAF entry shorter than the report bar drops the stall (the tab's slow-op covers it)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 5000, []);
    step(m, { type: "pong", portId: "a", now: T0 + 6000 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 900, 4600),
      now: T0 + 6050,
    });
    const fx = run(m, T0 + 7000, T0 + 9000, ["a"]);
    expect(of(fx, "deliver")).toEqual([]);
    expect(m.incidents.size).toBe(0);
  });
});

describe("endings", () => {
  test("log lines ride an answering tab, never the frozen one", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    const fx = run(m, T0, T0 + 3000, ["b"]);
    const open = of(fx, "log").find((l) => l.line.kind === "open");
    expect(open?.portId).toBe("b");
  });

  test("gone: the lock is released while frozen — filed by the reloaded tab (same tabId)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B", { visible: false }));
    run(m, T0, T0 + 10_000, ["b"]);
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 10_500 });
    // Delivered to the only live tab for now…
    expect(of(fx, "deliver")[0]?.portId).toBe("b");
    expect(of(fx, "deliver")[0]?.payload.ended).toBe("gone");
    expect(of(fx, "deliver")[0]?.payload.framesDuring).toBe(0);
    expect(of(fx, "deliver")[0]?.payload.durationMs).toBe(10_500);
  });

  test("gone with no live tab: held until a tab attaches, preferring the same tabId", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 6000, []);
    expect(
      of(step(m, { type: "gone", portId: "a", now: T0 + 6500 }), "deliver"),
    ).toEqual([]);
    const fx = attach(m, "a2", tab("A"), T0 + 8000);
    expect(of(fx, "deliver")[0]?.portId).toBe("a2");
  });

  test("frames delivered while the stall is open count as framesDuring (render storm)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 3000, []);
    for (let i = 0; i < 3; i++)
      step(m, {
        type: "frame",
        portId: "a",
        frame: frame(T0 + 3100 + i * 300, 250),
        now: T0 + 3500 + i * 300,
      });
    run(m, T0 + 4000, T0 + 7000, []);
    step(m, { type: "gone", portId: "a", now: T0 + 7500 });
    expect([...m.outbox.values()][0]?.payload.framesDuring).toBe(3);
  });

  test("an open stall is persisted at the report bar and at each doubling (lower bound for unknown)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    const fx = run(m, T0, T0 + 21_000, []);
    const persisted = of(fx, "persist").map((p) => p.record.payload);
    expect(persisted.map((p) => p.durationMs)).toEqual([5000, 10_000, 20_000]);
    expect(
      persisted.every((p) => p.ended === "unknown" && p.durationIsLowerBound),
    ).toBe(true);
  });

  test("an adopted orphan record is re-owned and delivered; the ack forgets it", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    const fx = step(m, {
      type: "adopt",
      record: {
        id: "old",
        owner: "dead-worker",
        payload: {
          ...tab("A"),
          startedAt: 1,
          endedAt: 9001,
          durationMs: 9000,
          durationIsLowerBound: true,
          ended: "unknown",
          detector: "worker",
          framesDuring: 0,
          stallFrame: null,
          frames: [],
          cohort: [],
          topFunction: null,
        },
      },
    });
    expect(of(fx, "persist")[0]?.record.owner).toBe("w1");
    expect(of(fx, "deliver")[0]?.id).toBe("old");
    expect(step(m, { type: "filed", id: "old", ok: true })).toEqual([
      { type: "forget", id: "old" },
    ]);
  });

  test("a failed filing keeps the record stored (no forget)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 6000, []);
    const id = [...m.incidents.keys()][0]!;
    step(m, { type: "gone", portId: "a", now: T0 + 6500 });
    attach(m, "b", tab("B"), T0 + 7000);
    const fx = step(m, { type: "filed", id, ok: false });
    expect(of(fx, "forget")).toEqual([]);
    expect(m.outbox.size).toBe(0);
  });

  test("a delivery to a tab that goes away is re-delivered", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    attach(m, "c", tab("C"));
    run(m, T0, T0 + 6000, ["b", "c"]);
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 6500 });
    const first = of(fx, "deliver")[0]!.portId;
    const again = step(m, { type: "gone", portId: first, now: T0 + 6600 });
    expect(of(again, "deliver")).toHaveLength(1);
    expect(of(again, "deliver")[0]!.portId).not.toBe(first);
  });
});

describe("noise", () => {
  test("sleep: a late worker tick resets every tab and files nothing", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 1000, ["a"]);
    // The machine slept 60 s: no tick, no pong.
    const fx = step(m, { type: "tick", now: T0 + 61_000 });
    expect(of(fx, "log").some((l) => l.line.kind === "sleep")).toBe(true);
    expect(m.incidents.size).toBe(0);
    run(m, T0 + 62_000, T0 + 62_000, ["a"]);
    expect(m.incidents.size).toBe(0);
  });

  test("sleep while a stall is open drops it (forgetting a persisted record)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 6000, []);
    expect(m.incidents.size).toBe(1);
    const fx = step(m, { type: "tick", now: T0 + 60_000 });
    expect(m.incidents.size).toBe(0);
    expect(of(fx, "forget")).toHaveLength(1);
    expect(m.outbox.size).toBe(0);
  });

  test("a clock stop/start is not a sleep", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 1000, ["a"]);
    step(m, { type: "clock-stopped" });
    step(m, {
      type: "state",
      portId: "a",
      tab: tab("A"),
      frozen: false,
      now: T0 + 60_000,
    });
    const fx = step(m, { type: "tick", now: T0 + 60_000 });
    expect(of(fx, "log").some((l) => l.line.kind === "sleep")).toBe(false);
  });

  test("a hidden tab that goes quiet is logged once, never reported", () => {
    const m = machine();
    attach(m, "a", tab("A", { visible: false }));
    const fx = run(m, T0, T0 + 20_000, []);
    expect(m.incidents.size).toBe(0);
    expect(
      of(fx, "log").filter((l) => l.line.kind === "suppressed"),
    ).toHaveLength(1);
  });

  test("a frozen (Page Lifecycle) tab is suppressed", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    step(m, {
      type: "state",
      portId: "a",
      tab: tab("A"),
      frozen: true,
      now: T0,
    });
    run(m, T0, T0 + 10_000, []);
    expect(m.incidents.size).toBe(0);
  });

  test("a tab coming back into view restarts its clock", () => {
    const m = machine();
    attach(m, "a", tab("A", { visible: false }));
    run(m, T0, T0 + 10_000, []);
    step(m, {
      type: "state",
      portId: "a",
      tab: tab("A"),
      frozen: false,
      now: T0 + 10_500,
    });
    run(m, T0 + 11_000, T0 + 12_000, []);
    expect(m.incidents.size).toBe(0);
  });

  test("needsClock: only while a visible tab is attached or a stall is in flight", () => {
    const m = machine();
    expect(needsClock(m)).toBe(false);
    attach(m, "a", tab("A", { visible: false }));
    expect(needsClock(m)).toBe(false);
    step(m, {
      type: "state",
      portId: "a",
      tab: tab("A"),
      frozen: false,
      now: T0,
    });
    expect(needsClock(m)).toBe(true);
  });
});

describe("cohort", () => {
  test("tabs that go quiet together are ONE incident, the focused visible tab primary", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B", { focused: true }));
    attach(m, "c", tab("C", { visible: false }));
    attach(m, "d", tab("D"));
    const fx = run(m, T0, T0 + 9000, ["d"]);
    expect(m.incidents.size).toBe(1);
    expect(of(fx, "log").filter((l) => l.line.kind === "open")).toHaveLength(1);
    step(m, { type: "gone", portId: "b", now: T0 + 9500 });
    const o = [...m.outbox.values()][0]!;
    const d = o.payload;
    // Still-frozen cohort tabs neither file it nor open a second incident.
    expect(o.deliveredTo).toBe("d");
    run(m, T0 + 10_000, T0 + 12_000, ["d"]);
    expect(m.incidents.size).toBe(0);
    expect(d.tabId).toBe("B");
    expect(d.cohort.map((t) => t.tabId).sort()).toEqual(["A", "C"]);
  });

  test("a tab going quiet well after an open stall's onset is its own incident", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    run(m, T0, T0 + 3000, ["b"]); // a stops after T0
    run(m, T0 + 4000, T0 + 7000, []); // b stops after T0+3000 — outside the window
    expect(m.incidents.size).toBe(2);
  });

  test("a tab going quiet within the window of an open stall joins it", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    run(m, T0, T0 + 1000, ["b"]);
    run(m, T0 + 2000, T0 + 6000, []);
    // a stopped after T0, b after T0+1000: within COHORT_WINDOW_MS ⇒ one.
    expect(m.incidents.size).toBe(1);
  });
});
