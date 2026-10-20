/**
 * Tests for the pure parts of the label layer: the `noteLabelFontPx` sizing
 * rules (the prototype's 11–17px band — these tests pin the exact behaviour
 * the visual design was tuned against) and the `createLabelWindow`
 * binary-search windowing.
 */
import { expect, test } from "bun:test";
import { createLabelWindow, noteLabelFontPx } from "./labels";

// --- noteLabelFontPx ------------------------------------------------------------

test("skips a bar too short to hold a label", () => {
  expect(noteLabelFontPx(20, 11, false)).toBeNull();
  expect(noteLabelFontPx(20, 11.5, false)).not.toBeNull();
});

test("skips a column too narrow for the floor", () => {
  // widthFit = w·0.78 (natural) / w·0.72 (accidental) < 7 ⇒ null.
  expect(noteLabelFontPx(8.9, 100, false)).toBeNull();
  expect(noteLabelFontPx(9, 100, false)).toBe(11);
  expect(noteLabelFontPx(9.5, 100, true)).toBeNull();
});

test("width drives the size inside the 11–17px band", () => {
  expect(noteLabelFontPx(18, 1000, false)).toBeCloseTo(18 * 0.78, 10);
  expect(noteLabelFontPx(12, 1000, false)).toBe(11);
  expect(noteLabelFontPx(60, 1000, false)).toBe(17);
  expect(noteLabelFontPx(500, 1000, true)).toBe(17);
});

test("an accidental shrinks the width fraction", () => {
  expect(noteLabelFontPx(20, 1000, true)).toBeCloseTo(20 * 0.72, 10);
  expect(noteLabelFontPx(20, 1000, true)!).toBeLessThan(
    noteLabelFontPx(20, 1000, false)!,
  );
});

test("short bars cap the size at 85% of the bar height", () => {
  expect(noteLabelFontPx(20, 14, false)).toBeCloseTo(14 * 0.85, 10);
});

// --- createLabelWindow ------------------------------------------------------------

const onsets = (...secs: number[]) => secs.map((y0Sec) => ({ y0Sec }));

test("returns the half-open index range of onsets in [minSec, maxSec]", () => {
  const query = createLabelWindow(onsets(0, 1, 2, 3, 4, 5));
  expect(query(1, 3)).toEqual({ start: 1, end: 4 }); // inclusive both ends
  expect(query(0.5, 3.5)).toEqual({ start: 1, end: 4 });
  expect(query(-10, 10)).toEqual({ start: 0, end: 6 });
});

test("boundary onsets are included on both edges", () => {
  const query = createLabelWindow(onsets(0, 1, 2, 3));
  expect(query(0, 0)).toEqual({ start: 0, end: 1 });
  expect(query(3, 3)).toEqual({ start: 3, end: 4 });
});

test("empty ranges produce start === end (nothing live)", () => {
  const query = createLabelWindow(onsets(0, 1, 2, 3));
  expect(query(1.2, 1.8)).toEqual({ start: 2, end: 2 });
  expect(query(10, 20)).toEqual({ start: 4, end: 4 });
  expect(query(-5, -1)).toEqual({ start: 0, end: 0 });
});

test("duplicate onsets (chords) are all included", () => {
  const query = createLabelWindow(onsets(0, 1, 1, 1, 2));
  expect(query(1, 1)).toEqual({ start: 1, end: 4 });
});

test("empty note list always yields the empty window", () => {
  const query = createLabelWindow([]);
  expect(query(0, 100)).toEqual({ start: 0, end: 0 });
});
