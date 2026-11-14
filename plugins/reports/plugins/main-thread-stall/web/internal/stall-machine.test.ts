import { describe, expect, test } from "bun:test";
import {
  mainThreadStallFingerprint,
  MainThreadStallPayloadSchema,
  mainThreadStallSummary,
  type MainThreadStallDraft,
  type MainThreadStallPayload,
  slowInteractionFingerprint,
  type InteractionTarget,
  type StallFrame,
  type StallTab,
  type TaskMark,
} from "../../core";
import { STALL } from "./constants";
import type { InteractionBegin } from "./interaction-judge";
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
        startMs: 0,
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

  test("frames of the freeze that arrive after the pong are its own, and attribute it", () => {
    // report-1793833639-4dssiq: a 13 s recovered stall with no single LoAF
    // entry ≥ OPEN_AFTER_MS — its shorter frames arrived while settling.
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 13_000, []);
    step(m, { type: "pong", portId: "a", now: T0 + 14_000 });
    // Five 1.5 s frames (none a stall frame on its own) cover 7.5 of 14 s.
    for (let i = 4; i >= 0; i--)
      step(m, {
        type: "frame",
        portId: "a",
        frame: frame(T0 + 1000 + i * 2000, 1500, "storm"),
        now: T0 + 14_100,
      });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 11_600, 900, "other"),
      now: T0 + 14_200,
    });
    const [d] = of(run(m, T0 + 16_000, T0 + 16_000, ["a"]), "deliver");
    expect(d?.payload.stallFrame).toBeNull();
    expect(d?.payload.framesDuring).toBe(6);
    expect(d?.payload.during.map((f) => f.startedAt)).toEqual([
      T0 + 1000,
      T0 + 3000,
      T0 + 5000,
      T0 + 7000,
      T0 + 9000,
      T0 + 11_600,
    ]);
    expect(d?.payload.frames).toEqual([]);
    expect(d?.payload.topFunction).toBe("storm (Window.setTimeout)");
  });

  test("frames covering little of the silence do not attribute it (a starved thread)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 13_000, []);
    step(m, { type: "pong", portId: "a", now: T0 + 14_000 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 6000, 400, "innocent"),
      now: T0 + 14_100,
    });
    const [d] = of(run(m, T0 + 16_000, T0 + 16_000, ["a"]), "deliver");
    expect(d?.payload.framesDuring).toBe(1);
    expect(d?.payload.topFunction).toBeNull();
  });

  test("with a LoAF entry for the freeze, frames between the last pong and it are breadcrumbs", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 9000, []);
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 200, 500, "before"),
      now: T0 + 9100,
    });
    step(m, { type: "pong", portId: "a", now: T0 + 9200 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 800, 8000),
      now: T0 + 9300,
    });
    const [d] = of(run(m, T0 + 12_000, T0 + 12_000, ["a"]), "deliver");
    expect(d?.payload.startedAt).toBe(T0 + 800);
    expect(d?.payload.during).toEqual([]);
    expect(d?.payload.framesDuring).toBe(0);
    expect(d?.payload.frames.map((f) => f.startedAt)).toEqual([T0 + 200]);
  });

  test("breadcrumbs are only the long frames that ended shortly before the stall, oldest first", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    const old = T0 - STALL.CRUMB_WINDOW_MS - 20_000;
    for (const f of [
      frame(T0 - 3000, 400),
      frame(old, 800),
      frame(T0 - 6000, 300),
    ])
      step(m, { type: "frame", portId: "a", frame: f, now: T0 });
    run(m, T0, T0 + 6000, []);
    step(m, { type: "gone", portId: "a", now: T0 + 6500 });
    const payload = [...m.outbox.values()][0]?.payload;
    expect(payload?.frames.map((f) => f.startedAt)).toEqual([
      T0 - 6000,
      T0 - 3000,
    ]);
    expect(payload?.topFunction).toBeNull();
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
          during: [],
          frames: [],
          cohort: [],
          topFunction: null,
          marks: [],
          frozenIn: null,
          interaction: null,
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

function mark(
  m: StallMachine,
  portId: string,
  at: number,
  what: string,
): TaskMark {
  const k = { at, source: "live-state", what, detail: "42 B" };
  step(m, { type: "mark", portId, id: ++markIds, mark: k });
  return k;
}
let markIds = 0;

/** End the port's latest mark. */
const markEnd = (m: StallMachine, portId: string) =>
  step(m, { type: "mark-end", portId, id: markIds });

describe("task marks", () => {
  test("the 2026-11-08 shape: a gone stall names the marked task left open", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    const before = mark(m, "a", T0 - 500, "update prototypes.state.all");
    markEnd(m, "a");
    step(m, { type: "pong", portId: "a", now: T0 });
    const frozen = mark(m, "a", T0 + 100, "update tasks.v2:rows");
    run(m, T0 + 1000, T0 + 9000, ["b"]);
    // Reload: Chrome terminates the script; the tab answers once, runs a
    // queued frame, its LoAF entry arrives, then it goes.
    step(m, { type: "pong", portId: "a", now: T0 + 9200 });
    mark(m, "a", T0 + 9210, "sub-ack config-v2.values");
    markEnd(m, "a");
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 90, 9050, "(anonymous)"),
      now: T0 + 9250,
    });
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 9300 });
    const d = of(fx, "deliver")[0]?.payload;
    expect(d?.ended).toBe("gone");
    expect(d?.frozenIn).toEqual(frozen);
    expect(d?.marks).toEqual([before, frozen]);
    expect(mainThreadStallFingerprint(d!)).toBe(
      "main-thread-stall:agent-manager|conversation|(anonymous) (Window.setTimeout)|live-state:update tasks.v2:rows",
    );
    expect(mainThreadStallSummary(d!)).toContain(
      "in live-state update tasks.v2:rows",
    );
  });

  test("a marked task that ended just before an unmarked freeze is not blamed (the first e2e run's shape)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    const finished = mark(m, "a", T0 + 100, "update db-lock-watch");
    markEnd(m, "a");
    run(m, T0 + 1000, T0 + 8000, ["b"]);
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 8100 });
    const d = of(fx, "deliver")[0]?.payload;
    expect(d?.frozenIn).toBeNull();
    expect(d?.marks).toEqual([finished]);
    expect(mainThreadStallFingerprint(d!)).toBe(
      "main-thread-stall:agent-manager|conversation|unattributed",
    );
  });

  test("tasks the tab runs once it is back (before the recovering pong) are not the frozen one", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    step(m, { type: "pong", portId: "a", now: T0 });
    const frozen = mark(m, "a", T0 + 100, "update tasks.v2:rows");
    run(m, T0 + 1000, T0 + 7000, []);
    // The thread comes back: the frozen task ends, a queued frame runs, then
    // the ping is answered.
    markEnd(m, "a");
    mark(m, "a", T0 + 7400, "update notifications");
    markEnd(m, "a");
    step(m, { type: "pong", portId: "a", now: T0 + 7500 });
    const d = of(run(m, T0 + 10_000, T0 + 10_000, ["a"]), "deliver")[0]
      ?.payload;
    expect(d?.ended).toBe("recovered");
    expect(d?.frozenIn).toEqual(frozen);
  });

  test("an open stall's persisted record already names the frozen task (the watchdog may die with it)", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    step(m, { type: "pong", portId: "a", now: T0 });
    const frozen = mark(m, "a", T0 + 100, "delta notifications");
    const fx = run(m, T0 + 1000, T0 + 6000, []);
    const [rec] = of(fx, "persist");
    expect(rec?.record.payload.ended).toBe("unknown");
    expect(rec?.record.payload.frozenIn).toEqual(frozen);
  });

  test("a late end of an earlier task does not close a later task's mark", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    mark(m, "a", T0 + 100, "update first");
    const earlier = markIds;
    const frozen = mark(m, "a", T0 + 101, "update second");
    step(m, { type: "mark-end", portId: "a", id: earlier });
    run(m, T0 + 1000, T0 + 8000, ["b"]);
    const fx = step(m, { type: "gone", portId: "a", now: T0 + 8100 });
    expect(of(fx, "deliver")[0]?.payload.frozenIn).toEqual(frozen);
  });

  test("marks are not a sign of life: a tab that marks but never answers stays stalled", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 3000, []);
    expect(m.incidents.size).toBe(1);
    mark(m, "a", T0 + 3100, "update x");
    run(m, T0 + 4000, T0 + 4000, []);
    expect([...m.incidents.values()][0]?.phase).toBe("open");
  });

  test("the per-tab ring keeps the latest MARKS", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    for (let i = 0; i < STALL.MARKS + 5; i++) mark(m, "a", T0 + i, `t${i}`);
    const p = m.ports.get("a")!;
    expect(p.marks.length).toBe(STALL.MARKS);
    expect(p.marks.at(-1)?.what).toBe(`t${STALL.MARKS + 4}`);
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

const BUTTON: InteractionTarget = {
  kind: "click",
  key: null,
  element: "button — Full screen",
  contribution: "desktop@ActionBar.Item",
  pane: null,
  owner: "FullscreenButton",
};

let interactionIds = 0;
function interact(
  m: StallMachine,
  portId: string,
  at: number,
  target = BUTTON,
): InteractionBegin {
  const interaction = { target, eventType: "pointerdown", at };
  step(m, { type: "interaction", portId, id: ++interactionIds, interaction });
  return interaction;
}
/** The port's latest interaction reached its next paint. */
const painted = (m: StallMachine, portId: string) =>
  step(m, { type: "interaction-end", portId, id: interactionIds });

/** A frame whose one script is mostly forced style/layout. */
function forcedFrame(startedAt: number, durationMs: number): StallFrame {
  const f = frame(startedAt, durationMs, "onToggle");
  return {
    ...f,
    styleAndLayoutStartMs: durationMs - 100,
    scripts: [
      {
        ...f.scripts[0]!,
        invokerType: "event-listener",
        invoker: "BUTTON.onpointerdown",
        startMs: 10,
        durationMs: durationMs - 200,
        forcedStyleAndLayoutDurationMs: durationMs - 1200,
      },
    ],
  };
}

describe("interactions", () => {
  test("a click whose handler froze the tab: the report is keyed by the control, its breakdown from the frozen frame", () => {
    const m = machine();
    attach(m, "a", tab("A", { focused: true }));
    step(m, { type: "pong", portId: "a", now: T0 });
    interact(m, "a", T0 + 300);
    run(m, T0 + 1000, T0 + 8000, []);
    step(m, { type: "pong", portId: "a", now: T0 + 8500 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: forcedFrame(T0 + 300, 8000),
      now: T0 + 8600,
    });
    const d = of(run(m, T0 + 11_000, T0 + 11_000, ["a"]), "deliver")[0]
      ?.payload;
    expect(d?.interaction?.target).toEqual(BUTTON);
    expect(d?.interaction?.startedAt).toBe(T0 + 300);
    expect(d?.interaction?.forcedBy).toBe("onToggle (BUTTON.onpointerdown)");
    expect(d?.interaction?.breakdown).toEqual({
      scriptMs: 1000,
      forcedStyleLayoutMs: 6800,
      styleLayoutMs: 100,
      otherMs: 100,
    });
    expect(mainThreadStallFingerprint(d!)).toBe(
      "main-thread-stall:interaction:click|desktop@ActionBar.Item|-|FullscreenButton|button — Full screen",
    );
    // The same identity as the control's slow-interaction rows.
    expect(mainThreadStallFingerprint(d!).split(":interaction:")[1]).toBe(
      slowInteractionFingerprint({ target: BUTTON } as never).split(
        "slow-interaction:",
      )[1],
    );
    expect(mainThreadStallSummary(d!)).toContain(
      "after click button — Full screen in desktop@ActionBar.Item (FullscreenButton)",
    );
    expect(mainThreadStallSummary(d!)).toContain(
      "forced style/layout 6800 ms (onToggle (BUTTON.onpointerdown))",
    );
  });

  test("the same control freezing on another screen is the same report", () => {
    // Gone, filed through the other live tab.
    const rec = (t: StallTab) => {
      const m = machine();
      attach(m, "a", t);
      attach(m, "b", tab("B"));
      step(m, { type: "pong", portId: "a", now: T0 });
      interact(m, "a", T0 + 100);
      run(m, T0 + 1000, T0 + 7000, ["b"]);
      return of(
        step(m, { type: "gone", portId: "a", now: T0 + 7100 }),
        "deliver",
      )[0]!.payload;
    };
    const a = rec(tab("A"));
    const b = rec(tab("A", { app: "sonata", routePattern: "(root)" }));
    expect(mainThreadStallFingerprint(a)).toBe(mainThreadStallFingerprint(b));
    // Gone: no frame came back, so all of its time is `other`.
    expect(a.interaction?.breakdown).toEqual({
      scriptMs: 0,
      forcedStyleLayoutMs: 0,
      styleLayoutMs: 0,
      otherMs: 7000,
    });
  });

  test("an interaction that painted before an unrelated freeze is not blamed", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    interact(m, "a", T0 + 100);
    painted(m, "a");
    run(m, T0 + 1000, T0 + 8000, ["b"]);
    const d = of(
      step(m, { type: "gone", portId: "a", now: T0 + 8100 }),
      "deliver",
    )[0]?.payload;
    expect(d?.interaction).toBeNull();
    expect(mainThreadStallFingerprint(d!)).toBe(
      "main-thread-stall:agent-manager|conversation|unattributed",
    );
  });

  test("a late end of an earlier interaction does not close a later one", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    interact(m, "a", T0 + 100);
    const earlier = interactionIds;
    interact(m, "a", T0 + 120);
    step(m, { type: "interaction-end", portId: "a", id: earlier });
    run(m, T0 + 1000, T0 + 8000, ["b"]);
    const d = of(
      step(m, { type: "gone", portId: "a", now: T0 + 8100 }),
      "deliver",
    )[0]?.payload;
    expect(d?.interaction?.startedAt).toBe(T0 + 120);
  });

  test("a marked task begun after the interaction and still open is the freeze, not the click", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    interact(m, "a", T0 + 100);
    const frozen = mark(m, "a", T0 + 150, "update tasks.v2:rows");
    run(m, T0 + 1000, T0 + 8000, ["b"]);
    const d = of(
      step(m, { type: "gone", portId: "a", now: T0 + 8100 }),
      "deliver",
    )[0]?.payload;
    expect(d?.interaction).toBeNull();
    expect(d?.frozenIn).toEqual(frozen);
  });

  test("an interaction is not a sign of life", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    run(m, T0, T0 + 3000, []);
    interact(m, "a", T0 + 3100);
    run(m, T0 + 4000, T0 + 4000, []);
    expect([...m.incidents.values()][0]?.phase).toBe("open");
  });

  test("an open stall's persisted record already names the interaction", () => {
    const m = machine();
    attach(m, "a", tab("A"));
    step(m, { type: "pong", portId: "a", now: T0 });
    interact(m, "a", T0 + 100);
    const [rec] = of(run(m, T0 + 1000, T0 + 6000, []), "persist");
    expect(rec?.record.payload.ended).toBe("unknown");
    expect(rec?.record.payload.interaction?.target).toEqual(BUTTON);
  });
});

describe("sampled stacks", () => {
  // The watchdog's draft carries no stacks: only the stalled tab can add them.
  function recovered(): MainThreadStallDraft {
    const m = machine();
    attach(m, "a", tab("A"));
    attach(m, "b", tab("B"));
    step(m, { type: "pong", portId: "a", now: T0 });
    run(m, T0 + 1000, T0 + 9000, ["b"]);
    step(m, { type: "pong", portId: "a", now: T0 + 9000 });
    step(m, {
      type: "frame",
      portId: "a",
      frame: frame(T0 + 300, 8700),
      now: T0 + 9100,
    });
    const d = of(run(m, T0 + 10_000, T0 + 12_000, ["a", "b"]), "deliver")[0]
      ?.payload;
    if (!d) throw new Error("no stall delivered");
    expect("stacks" in d).toBe(false);
    return d;
  }

  test("never change the fingerprint or summary: the same freeze stays one row", () => {
    const d = recovered();
    const sampled: MainThreadStallPayload = {
      ...d,
      stacks: {
        kind: "sampled",
        sampleIntervalMs: 20,
        sampledMs: 8700,
        noJsMs: 0,
        truncated: false,
        stacks: [{ ms: 8700, samples: 435, frames: ["spin (app.js:1:1)"] }],
        topSelf: [{ frame: "spin (app.js:1:1)", ms: 8700 }],
      },
    };
    const unavailable: MainThreadStallPayload = {
      ...d,
      stacks: { kind: "unavailable", reason: "filed by another tab" },
    };
    expect(mainThreadStallFingerprint(sampled)).toBe(
      mainThreadStallFingerprint(unavailable),
    );
    expect(mainThreadStallFingerprint(sampled)).toBe(
      mainThreadStallFingerprint(d),
    );
    expect(mainThreadStallSummary(sampled)).toBe(mainThreadStallSummary(d));
    expect(MainThreadStallPayloadSchema.parse(sampled).stacks).toEqual(
      sampled.stacks,
    );
  });

  test("a report filed before stacks existed parses as unavailable, with the reason", () => {
    const old = MainThreadStallPayloadSchema.parse(recovered());
    expect(old.stacks.kind).toBe("unavailable");
  });
});
