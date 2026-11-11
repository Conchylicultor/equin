import { describe, expect, test } from "bun:test";
import type { StallFrame } from "../../core";
import {
  INTERACTION,
  attribute,
  frameClaimed,
  judgeInteraction,
  longestEntry,
  phasesOf,
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

const frame = (
  start: number,
  end: number,
  scripts: RawScript[],
  styleAndLayoutStart = 0,
): RawFrame => ({ start, end, styleAndLayoutStart, scripts, frame: stub });

describe("attribute", () => {
  test("the four layers partition the window, forced layout named", () => {
    // 1000 → 1600: a click handler 100 ms, a commit 300 ms of which 250 forced
    // layout, then the frame's own style/layout 120 ms.
    const a = attribute({ start: 1000, end: 1600 }, [
      frame(
        1000,
        1580,
        [
          script(1010, 100, "onClick (BUTTON.onclick)"),
          script(1110, 300, "commitRoot (MessagePort.onmessage)", 250),
        ],
        1460,
      ),
    ]);
    expect(a.breakdown).toEqual({
      scriptMs: 150,
      forcedStyleLayoutMs: 250,
      styleLayoutMs: 120,
      otherMs: 80,
    });
    expect(a.forcedBy).toBe("commitRoot (MessagePort.onmessage)");
    expect(a.topFunction).toBe("commitRoot (MessagePort.onmessage)");
    expect(a.frames).toHaveLength(1);
  });

  test("scripts are clipped to the window, their forced layout pro rata", () => {
    const a = attribute({ start: 1000, end: 1200 }, [
      frame(800, 1200, [script(800, 400, "long (setTimeout)", 200)]),
    ]);
    // Half the script is inside: 200 ms, 100 of it forced.
    expect(a.breakdown.forcedStyleLayoutMs).toBe(100);
    expect(a.breakdown.scriptMs).toBe(100);
    expect(a.breakdown.otherMs).toBe(0);
  });

  test("a ResizeObserver callback inside the style/layout pass is script, not counted twice", () => {
    const a = attribute({ start: 0, end: 400 }, [
      frame(
        0,
        400,
        [script(200, 100, "(anonymous) (ResizeObserverCallback)", 60)],
        100,
      ),
    ]);
    expect(a.breakdown).toEqual({
      scriptMs: 40,
      forcedStyleLayoutMs: 60,
      styleLayoutMs: 200,
      otherMs: 100,
    });
  });

  test("frames outside the window are ignored; nothing attributed is all other", () => {
    const a = attribute({ start: 1000, end: 1300 }, [
      frame(0, 900, [script(0, 900, "earlier (setTimeout)", 500)]),
    ]);
    expect(a.breakdown).toEqual({
      scriptMs: 0,
      forcedStyleLayoutMs: 0,
      styleLayoutMs: 0,
      otherMs: 300,
    });
    expect(a.topFunction).toBeNull();
    expect(a.forcedBy).toBeNull();
    expect(a.frames).toEqual([]);
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
