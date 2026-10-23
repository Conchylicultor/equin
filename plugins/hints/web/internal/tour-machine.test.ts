import { describe, expect, test } from "bun:test";
import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { defineHintAnchor } from "../../core/internal/anchors";
import { defineTour, onSignal } from "../../core/internal/declarations";
import { defineHintSignal } from "../../core/internal/signals";
import type { TourTrigger } from "../../core";
import {
  beginTour,
  canGoBack,
  primaryMove,
  type PrimaryPress,
  type TourEvent,
  type TourRun,
  transitionTour,
} from "./tour-machine";

const app = defineApp({
  id: "home",
  name: "Home",
  basePath: "/home",
  iconKey: "home",
});
const a = defineHintAnchor("t.a");
const sent = defineHintSignal<{ taskId: string }>("t.sent");

const tour = defineTour<{ taskId?: string }>({
  id: "t",
  app,
  intro: { title: "Welcome", body: "" },
  initialData: {},
  steps: [
    {
      id: "one",
      anchor: a,
      title: "1",
      body: "",
      alt: { label: "Skip", to: "three" },
    },
    { id: "hover", anchor: a, title: "2", body: "", advanceOn: "anchor-hover" },
    {
      id: "three",
      anchor: a,
      title: "3",
      body: "",
      next: "none",
      onAnchorLost: "one",
      advanceOn: onSignal(sent, {
        update: (d: { taskId?: string }, p: { taskId: string }) => ({
          ...d,
          taskId: p.taskId,
        }),
      }),
    },
    { id: "last", anchor: null, title: "4", body: "" },
  ],
});

function run(events: TourEvent[], from: TourRun = beginTour(tour)) {
  let current: TourRun | null = from;
  let exit: string | undefined;
  for (const e of events) {
    if (!current) throw new Error("tour already over");
    const t = transitionTour(current, e);
    current = t.run;
    if (t.exit) exit = t.exit;
  }
  return { run: current, exit };
}

/**
 * Presses the primary the way the store does: a machine event is applied, a
 * `run` is called with a ctl whose moves are applied too. Reports the run
 * after it, and the `via` the `run` saw (null when no `run` ran).
 */
function press(
  from: TourRun,
  how: PrimaryPress,
): { run: TourRun | null; via: TourTrigger | null } {
  const move = primaryMove(from, how);
  if (move === null) return { run: from, via: null };
  if (move.kind === "event")
    return { run: run([move.event], from).run, via: null };
  let current: TourRun | null = from;
  const apply = (e: TourEvent) => {
    if (current) current = transitionTour(current, e).run;
  };
  move.run({
    via: move.via,
    go: (stepId) => apply({ type: "go", stepId }),
    next: () => apply({ type: "next" }),
    end: (outcome = "completed") => apply({ type: "end", outcome }),
    data: from.data,
    setData: (update) => apply({ type: "set-data", update }),
    navigate: () => undefined,
  });
  return { run: current, via: move.via };
}

describe("tour machine", () => {
  test("opens on the intro, then the first step", () => {
    expect(beginTour(tour).phase).toBe("intro");
    const r = run([{ type: "begin" }]).run;
    expect(r?.phase).toBe("step");
    expect(r?.stepId).toBe("one");
  });

  test("next walks the steps; back returns", () => {
    let r = run([{ type: "begin" }, { type: "next" }]).run;
    expect(r?.stepId).toBe("hover");
    r = run([{ type: "back" }], r!).run;
    expect(r?.stepId).toBe("one");
    expect(r?.history).toEqual([]);
  });

  test("alt jumps to its step", () => {
    expect(run([{ type: "begin" }, { type: "alt" }]).run?.stepId).toBe("three");
  });

  test("a gesture advances only a step that waits on it", () => {
    const one = run([{ type: "begin" }]).run!;
    expect(
      press(one, { by: "gesture", gesture: "anchor-hover" }).run?.stepId,
    ).toBe("one");
    const hover = run([{ type: "next" }], one).run!;
    expect(
      press(hover, { by: "gesture", gesture: "anchor-click" }).run?.stepId,
    ).toBe("hover");
    expect(
      press(hover, { by: "gesture", gesture: "anchor-hover" }).run?.stepId,
    ).toBe("three");
  });

  test("a gesture on the intro does nothing; the button begins", () => {
    const intro = beginTour(tour);
    expect(
      press(intro, { by: "gesture", gesture: "anchor-click" }).run?.phase,
    ).toBe("intro");
    expect(press(intro, { by: "button" }).run?.phase).toBe("step");
  });

  test("a gesture is the primary done by hand: it runs next.run, via anchor", () => {
    const acted = defineTour<object>({
      id: "acted",
      app,
      initialData: {},
      steps: [
        {
          id: "improve",
          anchor: a,
          title: "",
          body: "",
          advanceOn: "anchor-click",
          next: { label: "Try it", run: (ctl) => ctl.go("ask") },
        },
        { id: "skipped", anchor: a, title: "", body: "" },
        { id: "ask", anchor: a, title: "", body: "", next: "none" },
      ],
    });
    const start = beginTour(acted);
    const byHand = press(start, { by: "gesture", gesture: "anchor-click" });
    expect(byHand.run?.stepId).toBe("ask");
    expect(byHand.via).toBe("anchor");
    const byButton = press(start, { by: "button" });
    expect(byButton.run?.stepId).toBe("ask");
    expect(byButton.via).toBe("button");
    // The other gesture is not this step's: nothing moves, nothing runs.
    const hovered = press(start, { by: "gesture", gesture: "anchor-hover" });
    expect(hovered.run?.stepId).toBe("improve");
    expect(hovered.via).toBeNull();
  });

  test("→ stands down on a step without a primary button", () => {
    const three = run([{ type: "begin" }, { type: "alt" }]).run!;
    expect(press(three, { by: "key" }).run?.stepId).toBe("three");
    expect(press(three, { by: "button" }).run?.stepId).toBe("last");
  });

  test("a matching signal stores its payload and advances", () => {
    const r = run([
      { type: "begin" },
      { type: "alt" },
      { type: "signal", id: "other", payload: {} },
    ]).run;
    expect(r?.stepId).toBe("three");
    const after = run(
      [{ type: "signal", id: "t.sent", payload: { taskId: "task-1" } }],
      r!,
    ).run;
    expect(after?.stepId).toBe("last");
    expect(after?.data).toEqual({ taskId: "task-1" });
  });

  test("onAnchorLost fires only once the anchor was shown, without a history entry", () => {
    const at3 = run([{ type: "begin" }, { type: "alt" }]).run!;
    expect(run([{ type: "anchor-lost" }], at3).run?.stepId).toBe("three");
    const lost = run(
      [{ type: "anchor-shown" }, { type: "anchor-lost" }],
      at3,
    ).run;
    expect(lost?.stepId).toBe("one");
    expect(lost?.history).toEqual(["one"]);
  });

  test("set-data merges a patch or applies an updater", () => {
    let r = run([{ type: "set-data", update: { taskId: "x" } }]).run;
    expect(r?.data).toEqual({ taskId: "x" });
    r = run([{ type: "set-data", update: () => ({ taskId: "y" }) }], r!).run;
    expect(r?.data).toEqual({ taskId: "y" });
  });

  describe("every end path reports the exit", () => {
    test("finishing the last step → completed", () => {
      const r = run([
        { type: "begin" },
        { type: "go", stepId: "last" },
        { type: "next" },
      ]);
      expect(r.run).toBeNull();
      expect(r.exit).toBe("completed");
    });
    test("× / Esc → dismissed, from a step", () => {
      const r = run([{ type: "begin" }, { type: "end", outcome: "dismissed" }]);
      expect(r).toEqual({ run: null, exit: "dismissed" });
    });
    test("I'll explore on my own → skipped, from the intro", () => {
      expect(run([{ type: "end", outcome: "skipped" }])).toEqual({
        run: null,
        exit: "skipped",
      });
    });
    test("a signal advancing past the last step → completed", () => {
      const lastIsSignal = defineTour({
        id: "s",
        app,
        initialData: {},
        steps: [
          { id: "only", anchor: a, title: "", body: "", advanceOn: sent },
        ],
      });
      const r = run(
        [{ type: "signal", id: "t.sent", payload: { taskId: "1" } }],
        beginTour(lastIsSignal),
      );
      expect(r).toEqual({ run: null, exit: "completed" });
    });
  });

  test("a step's own back jumps there, rewinding the history; null offers none", () => {
    const withBack = defineTour({
      id: "b",
      app,
      initialData: {},
      steps: [
        { id: "s1", anchor: a, title: "", body: "" },
        { id: "s2", anchor: a, title: "", body: "" },
        { id: "s3", anchor: a, title: "", body: "", back: "s1" },
        { id: "s4", anchor: a, title: "", body: "", back: null },
      ],
    });
    const at3 = run(
      [{ type: "next" }, { type: "next" }],
      beginTour(withBack),
    ).run!;
    expect(at3.history).toEqual(["s1", "s2"]);
    expect(canGoBack(at3)).toBe(true);
    const back = run([{ type: "back" }], at3).run;
    expect(back?.stepId).toBe("s1");
    expect(back?.history).toEqual([]);
    const at4 = run([{ type: "next" }], at3).run!;
    expect(canGoBack(at4)).toBe(false);
    expect(run([{ type: "back" }], at4).run?.stepId).toBe("s4");
  });

  test("defineTour rejects a step name that is not a step", () => {
    expect(() =>
      defineTour({
        id: "bad",
        app,
        initialData: {},
        steps: [
          {
            id: "x",
            anchor: a,
            title: "",
            body: "",
            alt: { label: "", to: "nope" },
          },
        ],
      }),
    ).toThrow(/not a step/);
  });

  test("a data-dependent gesture advances only while the data asks for it", () => {
    const gated = defineTour<{ floating: boolean }>({
      id: "gated",
      app,
      initialData: { floating: false },
      steps: [
        {
          id: "bar",
          anchor: a,
          title: "",
          body: "",
          advanceOn: (d) => (d.floating ? "anchor-hover" : null),
        },
        { id: "after", anchor: a, title: "", body: "" },
      ],
    });
    const hover: PrimaryPress = { by: "gesture", gesture: "anchor-hover" };
    expect(press(beginTour(gated), hover).run?.stepId).toBe("bar");
    const floating = run(
      [{ type: "set-data", update: { floating: true } }],
      beginTour(gated),
    ).run!;
    expect(press(floating, hover).run?.stepId).toBe("after");
  });
});
