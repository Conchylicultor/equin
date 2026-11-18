import { describe, expect, test } from "bun:test";
import {
  applyLine,
  captionParts,
  currentGroup,
  currentStep,
  emptyView,
  pace,
  progress,
  remainingSeconds,
  remainingText,
  statusText,
  type InstallView,
} from "./model";

const T0 = Date.parse("2026-11-17T15:00:00Z");
/** An ISO instant `s` seconds after T0. */
const at = (s: number): string =>
  new Date(T0 + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const now = (s: number): number => T0 + s * 1000;

type Est = number | null;
function plan(
  est: {
    tools?: Est;
    clone?: Est;
    database?: Est;
    interface?: Est;
  } = {},
): string {
  return JSON.stringify({
    v: 1,
    t: at(0),
    type: "plan",
    release: null,
    platform: "darwin-arm64",
    mode: "window",
    groups: [
      { id: "prepare", label: "Prepare your Mac" },
      { id: "download", label: "Download equin" },
      { id: "build", label: "Build equin" },
    ],
    steps: [
      {
        id: "tools",
        label: "Prepare your Mac",
        doing: "Preparing your Mac",
        group: "prepare",
        est_s: est.tools ?? null,
      },
      {
        id: "clone",
        label: "Download equin",
        doing: "Downloading equin",
        group: "download",
        est_s: est.clone ?? null,
      },
      {
        id: "build",
        label: "Build equin",
        doing: "Building equin",
        group: "build",
        est_s: null,
        substeps: [
          {
            id: "build.database",
            label: "Prepare the database",
            doing: "Preparing the database",
            est_s: est.database ?? null,
          },
          {
            id: "build.interface",
            label: "Build the interface",
            doing: "Building the interface",
            est_s: est.interface ?? null,
          },
        ],
      },
    ],
  });
}
const step = (s: number, id: string, state: string, ms?: number): string =>
  JSON.stringify({
    v: 1,
    t: at(s),
    type: "step",
    id,
    state,
    ...(ms === undefined ? {} : { ms }),
  });
const log = (line: string): string =>
  JSON.stringify({
    v: 1,
    t: at(0),
    type: "log",
    step: "clone",
    stream: "out",
    line,
  });
const count = (
  s: number,
  id: string,
  done: number,
  total: number | null,
  unit = "plugins",
): string =>
  JSON.stringify({ v: 1, t: at(s), type: "progress", id, done, total, unit });
const wait = (
  s: number,
  state: "start" | "end",
  on = "host-grant",
  holder?: object,
): string =>
  JSON.stringify({
    v: 1,
    t: at(s),
    type: "wait",
    step: "build.interface",
    state,
    on,
    ...(holder ? { holder } : {}),
  });

function fold(lines: string[]): InstallView {
  const view = emptyView();
  for (const line of lines) applyLine(view, line);
  return view;
}

describe("installer page model", () => {
  test("running: the current step, its group, a log section per step", () => {
    const view = fold([
      plan(),
      step(0, "tools", "skipped"),
      step(1, "clone", "start"),
      log("\u001b[32mok\u001b[0m"),
    ]);
    expect(view.phase).toBe("running");
    expect(currentStep(view)?.step.label).toBe("Download equin");
    expect(currentGroup(view)).toEqual({ index: 1, count: 3 });
    expect(statusText(view, now(2))).toBe("Downloading equin…");
    expect(view.log).toEqual([
      { kind: "section", text: "Downloading equin" },
      { kind: "line", text: "ok" },
    ]);
  });

  test("a sub-step's section replaces its step's empty one; the status names the sub-step and its count", () => {
    const view = fold([
      plan(),
      step(0, "build", "start"),
      step(0, "build.database", "start"),
      step(5, "build.database", "done", 5000),
      step(5, "build.interface", "start"),
      count(6, "build.interface", 137, 312),
    ]);
    expect(view.log.map((r) => r.text)).toEqual([
      "Preparing the database",
      "Building the interface",
    ]);
    expect(statusText(view, now(7))).toBe(
      "Building the interface · 137 of 312 plugins built",
    );
    expect(currentGroup(view)).toEqual({ index: 2, count: 3 });
  });

  test("a count says what it counts, in the user's words", () => {
    const view = fold([
      plan(),
      step(0, "clone", "start"),
      count(1, "clone", 1088, 1385, "crates"),
    ]);
    expect(statusText(view, now(2))).toMatch(
      / · 1,088 of 1,385 components compiled$/,
    );
  });

  test("a count with no total yet, or one from before the step started, is not shown", () => {
    const unknown = fold([
      plan(),
      step(0, "clone", "start"),
      count(1, "clone", 3, null, "%"),
    ]);
    expect(statusText(unknown, now(2))).toBe("Downloading equin…");
    const pct = fold([
      plan(),
      step(0, "clone", "start"),
      count(1, "clone", 42, 100, "%"),
    ]);
    expect(statusText(pct, now(2))).toBe("Downloading equin · 42%");
    const stale = fold([
      plan(),
      step(0, "build", "start"),
      count(1, "build", 10, 20),
      step(2, "build.interface", "start"),
    ]);
    expect(statusText(stale, now(3))).toBe("Building the interface…");
  });

  test("a count that reached its total is not shown: the step runs on past it", () => {
    const view = fold([
      plan(),
      step(0, "build", "start"),
      step(0, "build.interface", "start"),
      count(1, "build.interface", 2294, 2294),
    ]);
    expect(statusText(view, now(600))).toBe("Building the interface…");
  });

  test("no estimates: no time, and the bar moves by finished steps, sub-steps as fractions", () => {
    const view = fold([
      plan(),
      step(0, "tools", "skipped"),
      step(0, "clone", "start"),
      step(10, "clone", "done", 10000),
      step(10, "build", "start"),
      step(10, "build.database", "start"),
      step(20, "build.database", "done", 10000),
      step(20, "build.interface", "start"),
    ]);
    expect(remainingSeconds(view, now(30))).toBeNull();
    expect(captionParts(view, now(30))).toEqual(["Step 3 of 3"]);
    expect(progress(view, now(30))).toBeCloseTo((1 + 1 + 0.5) / 3);
  });

  test("one step left without an estimate is enough to show no time", () => {
    const view = fold([
      plan({ clone: 10, database: 10 }),
      step(0, "clone", "start"),
    ]);
    expect(remainingSeconds(view, now(1))).toBeNull();
  });

  test("with estimates: time left scaled by this machine's pace, the bar by time", () => {
    const view = fold([
      plan({ tools: 5, clone: 20, database: 10, interface: 100 }),
      step(0, "tools", "skipped"),
      step(0, "clone", "start"),
      step(30, "clone", "done", 30000), // 1.5× slower than its median
      step(30, "build", "start"),
      step(30, "build.database", "start"),
    ]);
    expect(pace(view)).toBeCloseTo(1.5);
    // database: 10 × 1.5 − 6 worked = 9; interface 100 × 1.5 = 150.
    expect(remainingSeconds(view, now(36))).toBeCloseTo(159);
    expect(progress(view, now(36))).toBeCloseTo(36 / (36 + 159));
    expect(captionParts(view, now(36))).toEqual([
      "Step 3 of 3",
      "About 3 minutes remaining",
    ]);
    // A step running past its estimate counts 0, never below.
    expect(remainingSeconds(view, now(100))).toBeCloseTo(150);
  });

  test("pace is 1 before any estimated step finished", () => {
    const view = fold([
      plan({ tools: 0, clone: 20, database: 10, interface: 100 }),
      step(0, "clone", "start"),
    ]);
    expect(pace(view)).toBe(1);
    expect(remainingSeconds(view, now(5))).toBeCloseTo(15 + 10 + 100);
  });

  test("a wait is shown, and its time is not counted down", () => {
    const base = [
      plan({ tools: 0, clone: 20, database: 10, interface: 100 }),
      step(0, "clone", "start"),
      step(20, "clone", "done", 20000),
      step(20, "build", "start"),
      step(20, "build.database", "start"),
      step(30, "build.database", "done", 10000),
      step(30, "build.interface", "start"),
    ];
    const waiting = fold([...base, wait(40, "start")]);
    expect(statusText(waiting, now(50))).toBe(
      "Waiting for other work on this Mac to finish…",
    );
    expect(remainingSeconds(waiting, now(50))).toBeCloseTo(90);
    expect(remainingSeconds(waiting, now(500))).toBeCloseTo(90);

    const held = fold([
      ...base,
      wait(40, "start", "host-grant", {
        op: "op-1",
        kind: "test",
        startedAt: at(-3 * 3600),
      }),
    ]);
    expect(statusText(held, now(50))).toBe(
      "Waiting for another task to finish · a test started 3 hours ago",
    );

    const resumed = fold([...base, wait(40, "start"), wait(100, "end")]);
    expect(statusText(resumed, now(110))).toBe("Building the interface…");
    // 10 s before the wait + 10 s after it worked.
    expect(remainingSeconds(resumed, now(110))).toBeCloseTo(80);
  });

  test("remaining time, in words", () => {
    expect(remainingText(49)).toBe("Less than a minute remaining");
    expect(remainingText(60)).toBe("About 1 minute remaining");
    expect(remainingText(409)).toBe("About 7 minutes remaining");
  });

  test("a failed step pauses; a new start resumes and runs its sub-steps again", () => {
    const failed = fold([
      plan(),
      step(0, "build", "start"),
      step(0, "build.database", "start"),
      step(5, "build.database", "failed", 5000),
      step(5, "build", "failed", 5000),
    ]);
    expect(failed.phase).toBe("failed");
    expect(captionParts(failed, now(6))).toEqual(["Step 3 of 3", "Paused"]);
    const resumed = fold([
      plan(),
      step(0, "build", "start"),
      step(0, "build.database", "start"),
      step(5, "build.database", "failed", 5000),
      step(5, "build", "failed", 5000),
      step(9, "build", "start"),
    ]);
    expect(resumed.phase).toBe("running");
    expect(resumed.steps[2]?.substeps[0]?.state).toBe("pending");
  });

  test("done, then exit 0, stays done", () => {
    const view = fold([
      plan(),
      step(0, "clone", "done"),
      JSON.stringify({
        v: 1,
        t: at(1),
        type: "done",
        url: "http://equin.localhost:9000",
        ms: 1000,
      }),
      JSON.stringify({ v: 1, t: at(1), type: "exit", code: 0 }),
    ]);
    expect(view.phase).toBe("done");
    expect(view.doneUrl).toBe("http://equin.localhost:9000");
    expect(progress(view, now(2))).toBe(1);
  });

  test("exit without done is stopped", () => {
    const view = fold([
      plan(),
      step(0, "clone", "failed"),
      JSON.stringify({ v: 1, t: at(1), type: "exit", code: 1 }),
    ]);
    expect(view.phase).toBe("stopped");
    expect(view.exitCode).toBe(1);
  });

  test("a line outside the protocol is a loud error, and nothing after it is folded", () => {
    const view = fold([
      plan(),
      '{"v":2,"type":"plan"}',
      step(0, "clone", "start"),
    ]);
    expect(view.phase).toBe("protocol-error");
    expect(view.protocolError).toContain('{"v":2');
  });

  test("a step outside the plan is a protocol error", () => {
    const view = fold([plan(), step(0, "mise", "start")]);
    expect(view.phase).toBe("protocol-error");
  });
});

const ev = (s: number, body: object): string =>
  JSON.stringify({ v: 1, t: at(s), ...body });
const pauseEv = (s: number, blocking: boolean, kind = "unknown"): string =>
  ev(s, {
    type: "pause",
    step: "clone",
    kind,
    title: "Downloading equin didn't finish",
    text: "equin stopped while downloading equin.",
    evidence: ["fatal: unable to access", "step exit 128"],
    blocking,
    optional: false,
    manual: null,
  });

describe("installer page model: pauses, Fix with Claude, notices", () => {
  test("a blocking pause pauses the view; retry resolves it and the step runs again", () => {
    const view = fold([
      plan(),
      step(1, "clone", "start"),
      step(5, "clone", "failed", 4000),
      pauseEv(5, true),
    ]);
    expect(view.phase).toBe("paused");
    expect(view.pause).toMatchObject({
      kind: "unknown",
      blocking: true,
      evidence: ["fatal: unable to access", "step exit 128"],
    });
    expect(captionParts(view, now(6))).toEqual(["Step 2 of 3", "Paused"]);
    applyLine(view, ev(7, { type: "fixing", target: "cli", clipboard: false }));
    expect(view.fixing).toEqual({ target: "cli", clipboard: false });
    applyLine(view, ev(9, { type: "resolved", how: "retry" }));
    applyLine(view, step(9, "clone", "start"));
    expect(view.phase).toBe("running");
    expect(view.pause).toBeNull();
    expect(view.fixing).toBeNull();
  });

  test("a stall does not stop the step: it ends when the step moves again", () => {
    const view = fold([
      plan(),
      step(1, "clone", "start"),
      pauseEv(700, false, "stall"),
    ]);
    expect(view.phase).toBe("paused");
    expect(view.pause?.blocking).toBe(false);
    expect(captionParts(view, now(701))).toEqual([
      "Step 2 of 3",
      "Still waiting",
    ]);
    applyLine(view, ev(720, { type: "resolved", how: "progress" }));
    expect(view.phase).toBe("running");
    expect(currentStep(view)?.step.id).toBe("clone");
  });

  test("quit ends in the stopped screen", () => {
    const view = fold([
      plan(),
      step(1, "clone", "start"),
      step(2, "clone", "failed"),
      pauseEv(2, true),
      ev(3, { type: "resolved", how: "quit" }),
      ev(3, { type: "exit", code: 1 }),
    ]);
    expect(view.phase).toBe("stopped");
    expect(view.pause).toBeNull();
  });

  test("a notice keeps its latest state, through the done", () => {
    const notice = (state: string): string =>
      ev(1, {
        type: "notice",
        id: "dev.equin.menu-bar",
        state,
        title: "macOS blocked equin from adding its apps",
        text: "Turn it on.",
        without: "the menu-bar icon and app shortcuts",
      });
    const view = fold([
      plan(),
      notice("skipped"),
      ev(2, { type: "done", url: "http://equin.localhost:9000", ms: 2000 }),
    ]);
    expect(view.phase).toBe("done");
    expect(view.notice?.state).toBe("skipped");
    applyLine(view, notice("added"));
    expect(view.notice?.state).toBe("added");
  });

  test("the plan's release and platform are kept for a report", () => {
    const view = fold([plan()]);
    expect(view.release).toBeNull();
    expect(view.platform).toBe("darwin-arm64");
  });
});
