import { describe, expect, it } from "vitest";
import { rowOverflowEvidence } from "../internal/adaptive-bar";

/**
 * A `row-overflow` fault on a visitor's phone cannot be reproduced, and the
 * site keeps only the first 300 characters of its message. So the message
 * leads with the numbers the fit decided from and the row it rendered, in a
 * line short enough to survive that cut for a typical pane header.
 */
describe("rowOverflowEvidence", () => {
  const fit = {
    rowPx: 394,
    insetPx: 0,
    yieldFloorPx: 112,
    foreignPx: 8,
    gapPx: 4,
    budget: 274,
    triggerPx: null,
    widths: new Map<string, number | undefined>([["midi-folders", 26.88]]),
  };

  it("names each occupant's fit width against its rendered one, and the row's scale and scroll", () => {
    const text = rowOverflowEvidence(fit, {
      by: 1.6,
      box: { left: 0, right: 394 },
      spans: [{ id: "midi-folders", left: 366, right: 396.6 }],
      scale: 1,
      scrollLeft: 0,
    });
    expect(text).toBe(
      "fit: row 394 −inset 0 −floor 112 −foreign 8 = budget 274 ≥ total 26.9 (gap 4); rendered: box 0-394, midi-folders 26.9→30.6@366-396.6; scale 1, scroll 0",
    );
  });

  it("prices the ⋯ only when the fit evicted someone, with its gap", () => {
    const text = rowOverflowEvidence(
      { ...fit, triggerPx: 28 },
      {
        by: 2,
        box: { left: 0, right: 60 },
        spans: [
          { id: "midi-folders", left: 0, right: 28 },
          { id: "⋯", left: 32, right: 62 },
        ],
        scale: 0.96,
        scrollLeft: 0,
      },
    );
    expect(text).toContain("total 58.9");
    expect(text).toContain("⋯ 28→30@32-62");
    expect(text).toContain("scale 0.96");
  });

  it("stays short enough for the site's 300-character message with its prefix", () => {
    const text = rowOverflowEvidence(fit, {
      by: 1.6,
      box: { left: 0, right: 394 },
      spans: [{ id: "midi-folders", left: 366, right: 396.6 }],
      scale: 1,
      scrollLeft: 0,
    });
    const message = `Adaptive bar (apps.sonata.library#pane) — row-overflow: overflows by 1.6px though the fit said it fits — ${text}. The widths…`;
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
