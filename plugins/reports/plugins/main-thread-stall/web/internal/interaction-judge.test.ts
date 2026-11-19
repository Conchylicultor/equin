import { describe, expect, test } from "bun:test";
import type { StallFrame } from "../../core";
import {
  INTERACTION,
  attribute,
  frameClaimed,
  judgeInteraction,
  longestEntry,
  ownEnd,
  pageOwnMs,
  phasesOf,
  throttled,
  withheldOf,
  type RawFrame,
  type RawScript,
} from "./interaction-judge";

const stub: StallFrame = {
  startedAt: 0,
  durationMs: 0,
  blockingDurationMs: 0,
  renderStartMs: null,
  styleAndLayoutStartMs: null,
  scripts: [],
};

const script = (
  start: number,
  duration: number,
  label: string,
  forced = 0,
): RawScript => ({ start, duration, forced, label });

// A long frame whose tasks blocked throughout (the usual slow frame) unless
// `render` says when its render step began and how long it blocked.
const frame = (
  start: number,
  end: number,
  scripts: RawScript[],
  styleAndLayoutStart = 0,
  render: { renderStart: number; blocking: number } = {
    renderStart: 0,
    blocking: end - start,
  },
): RawFrame => ({
  start,
  end,
  styleAndLayoutStart,
  ...render,
  scripts,
  frame: stub,
});

describe("attribute", () => {
  test("the four layers partition the window, forced layout named", () => {
    // 1000 → 1600: a click handler 100 ms, a commit 300 ms of which 250 forced
    // layout, then the frame's own style/layout 120 ms.
    const a = attribute(
      { start: 1000, end: 1600 },
      [
        frame(
          1000,
          1580,
          [
            script(1010, 100, "onClick (BUTTON.onclick)"),
            script(1110, 300, "commitRoot (MessagePort.onmessage)", 250),
          ],
          1460,
        ),
      ],
      1000,
    );
    expect(a.breakdown).toEqual({
      scriptMs: 150,
      forcedStyleLayoutMs: 250,
      styleLayoutMs: 120,
      withheldMs: 0,
      otherMs: 80,
    });
    expect(a.forcedBy).toBe("commitRoot (MessagePort.onmessage)");
    expect(a.topFunction).toBe("commitRoot (MessagePort.onmessage)");
    expect(a.frames).toHaveLength(1);
  });

  test("scripts are clipped to the window, their forced layout pro rata", () => {
    const a = attribute(
      { start: 1000, end: 1200 },
      [frame(800, 1200, [script(800, 400, "long (setTimeout)", 200)])],
      1000,
    );
    // Half the script is inside: 200 ms, 100 of it forced.
    expect(a.breakdown.forcedStyleLayoutMs).toBe(100);
    expect(a.breakdown.scriptMs).toBe(100);
    expect(a.breakdown.otherMs).toBe(0);
  });

  test("a ResizeObserver callback inside the style/layout pass is script, not counted twice", () => {
    const a = attribute(
      { start: 0, end: 400 },
      [
        frame(
          0,
          400,
          [script(200, 100, "(anonymous) (ResizeObserverCallback)", 60)],
          100,
        ),
      ],
      0,
    );
    expect(a.breakdown).toEqual({
      scriptMs: 40,
      forcedStyleLayoutMs: 60,
      styleLayoutMs: 200,
      withheldMs: 0,
      otherMs: 100,
    });
  });

  test("frames outside the window are ignored; nothing attributed is all other", () => {
    const a = attribute(
      { start: 1000, end: 1300 },
      [frame(0, 900, [script(0, 900, "earlier (setTimeout)", 500)])],
      1000,
    );
    expect(a.breakdown).toEqual({
      scriptMs: 0,
      forcedStyleLayoutMs: 0,
      styleLayoutMs: 0,
      withheldMs: 0,
      otherMs: 300,
    });
    expect(a.topFunction).toBeNull();
    expect(a.forcedBy).toBeNull();
    expect(a.frames).toEqual([]);
  });
});

// The frames of real reports, on the performance clock (ms from the frame the
// interaction began in), as the tab held them.
describe("withheld rendering", () => {
  // report-1795095421-0r9u4n (equin.ai, macOS Chrome): a row click, 2280 ms to
  // its paint, three ~1 s frames tiling it with blocking 0 — the thread ran
  // ~100 ms of script, then waited ~280–980 ms per frame for a render step
  // the browser gave it about once a second.
  const throttledFrames: RawFrame[] = [
    frame(
      0,
      1013,
      [
        script(615, 27, "H (MessagePort.onmessage)", 16),
        script(658, 26, "runQueued (TimerHandler:setTimeout)", 5),
        script(691, 22, "runQueued (TimerHandler:setTimeout)", 4),
      ],
      996,
      { renderStart: 994, blocking: 0 },
    ),
    frame(1014, 1998, [], 1998, { renderStart: 1995, blocking: 0 }),
    frame(
      2000,
      2824,
      [script(2017, 28, "(anonymous) (TimerHandler:setTimeout)")],
      2823,
      { renderStart: 2818, blocking: 0 },
    ),
  ];
  const w0r9u4n = { start: 545, end: 545 + 2280 };

  test("a throttled renderer's free waits are withheld, not the page's", () => {
    expect(throttled(throttledFrames)).toBe(true);
    const a = attribute(w0r9u4n, throttledFrames, 545);
    // Frame 1 from the click (545) to its render (994): 449 − 75 script − 50;
    // frame 2: 981 − 50; frame 3: 818 − 28 − 50.
    expect(a.breakdown.withheldMs).toBe(324 + 931 + 740);
    expect(a.breakdown.scriptMs + a.breakdown.forcedStyleLayoutMs).toBe(103);
    // The page spent ~280 ms of the 2280: recorded, not a severe click.
    const own = pageOwnMs(2280, a.breakdown);
    expect(own).toBe(285);
    expect(judgeInteraction(own, 1, false)).toBe("record");
  });

  test("a frame whose tasks blocked keeps its time — a real slow click is still reported", () => {
    // report-1795081021-dfpksi: one 1544 ms frame, blocking 1494, 1540 ms of
    // script before its render step.
    const busy = frame(
      0,
      1544,
      [script(0, 1540, "onClick (BUTTON.onclick)")],
      1544,
      { renderStart: 1544, blocking: 1494 },
    );
    expect(withheldOf(busy, { start: 0, end: 1552 })).toBe(0);
    const a = attribute({ start: 0, end: 1552 }, [busy], 0);
    expect(a.breakdown.withheldMs).toBe(0);
    expect(judgeInteraction(pageOwnMs(1552, a.breakdown), 1, false)).toBe(
      "report",
    );
  });

  test("a chain of short tasks is script, not withheld", () => {
    // 20 × 40 ms tasks (none blocks) before the render: the page's own work.
    const scripts = Array.from({ length: 20 }, (_, i) =>
      script(i * 40, 40, "step (setTimeout)"),
    );
    const f = frame(0, 820, scripts, 800, { renderStart: 800, blocking: 0 });
    expect(withheldOf(f, { start: 0, end: 820 })).toBe(0);
  });

  test("a vsync's wait is not withheld", () => {
    const f = frame(0, 120, [script(0, 80, "x (setTimeout)")], 118, {
      renderStart: 118,
      blocking: 30,
    });
    expect(withheldOf(f, { start: 0, end: 120 })).toBe(0);
  });

  test("one suppressed frame is the page's own — a view transition awaiting its update", () => {
    // A 1.4 s frame, blocking 0, a 60 ms commit, its render step held until
    // the update resolved: the same shape as one throttled frame, but alone.
    const held = frame(0, 1400, [script(20, 60, "flushSync (click)")], 1395, {
      renderStart: 1390,
      blocking: 0,
    });
    expect(throttled([held])).toBe(false);
    const a = attribute({ start: 0, end: 1408 }, [held], 0);
    expect(a.breakdown.withheldMs).toBe(0);
    expect(judgeInteraction(pageOwnMs(1408, a.breakdown), 1, false)).toBe(
      "report",
    );
  });

  test("counted from the handlers' start, never inside the input delay", () => {
    const a = attribute(w0r9u4n, throttledFrames, 845);
    // Frame 1 from 845 (after its last script) to its render: 149 − 50.
    expect(a.breakdown.withheldMs).toBe(99 + 931 + 740);
  });

  test("not measured without the frames' every script (the stall path)", () => {
    const a = attribute(w0r9u4n, throttledFrames, null);
    expect(a.breakdown.withheldMs).toBeNull();
  });
});

describe("judgeInteraction", () => {
  test("severe reports at once", () => {
    expect(judgeInteraction(INTERACTION.SEVERE_MS, 1, false)).toBe("report");
  });
  test("under the severe bar, reported once its target recurs", () => {
    expect(judgeInteraction(400, 1, false)).toBe("record");
    expect(judgeInteraction(400, INTERACTION.RECUR_COUNT - 1, false)).toBe(
      "record",
    );
    expect(judgeInteraction(400, INTERACTION.RECUR_COUNT, false)).toBe(
      "report",
    );
  });
  test("under the recurrence bar, only recorded however often", () => {
    expect(judgeInteraction(250, 10, false)).toBe("record");
  });
  test("a freeze of stall size is the stall detector's report", () => {
    expect(judgeInteraction(6000, 1, false)).toBe("record");
    // Event Timing measured it just under the bar, but a long frame inside it
    // reached it: the stall detector files it (naming this interaction).
    expect(judgeInteraction(4990, 1, true)).toBe("record");
  });
});

describe("frameClaimed", () => {
  test("a long frame overlapping a slow interaction is the interaction's", () => {
    const slow = [{ start: 1000, end: 2200 }];
    expect(frameClaimed({ start: 1100, end: 2100 }, slow)).toBe(true);
    expect(frameClaimed({ start: 3000, end: 4200 }, slow)).toBe(false);
  });
});

describe("Event Timing entries", () => {
  const entry = (name: string, duration: number) => ({
    name,
    startTime: 100,
    duration,
    processingStart: 130,
    processingEnd: 180,
    interactionId: 7,
  });
  test("the longest entry stands for the interaction", () => {
    expect(
      longestEntry([
        entry("pointerdown", 208),
        entry("click", 504),
        entry("pointerup", 496),
      ]).name,
    ).toBe("click");
  });
  test("phases", () => {
    expect(phasesOf(entry("click", 504))).toEqual({
      inputDelayMs: 30,
      processingMs: 50,
      presentationDelayMs: 424,
    });
  });
});

describe("ownEnd", () => {
  // Alt+N as Playwright sends it: keydown Alt (no work), then keydown N (opens
  // a window) 0.2 ms later, both presented by one 88 ms frame.
  const alt = {
    name: "keydown",
    startTime: 868.9,
    duration: 88,
    processingStart: 869.1,
    processingEnd: 869.4,
    interactionId: 2500,
  };
  const nHandlers = 869.6;
  test("a later input's handlers in the same frame end this entry's own time", () => {
    expect(ownEnd(alt, [869.3, nHandlers])).toBe(nHandlers);
  });
  test("with no later input, its own time runs to its paint", () => {
    expect(ownEnd(alt, [869.3])).toBe(868.9 + 88);
  });
  test("an input after the paint, or before its handlers ended, is not inside it", () => {
    expect(ownEnd(alt, [700, 869.2, 2000])).toBe(868.9 + 88);
  });
});
