import { describe, expect, test } from "bun:test";
import {
  chipShifts,
  clampDraggedOffset,
  insertionIndex,
  type ChipSlot,
} from "./tab-strip-layout";

// Three chips: A [0,50), B [52,132), C [134,164) — gap 2.
const slots: ChipSlot[] = [
  { tabId: "A", left: 0, width: 50 },
  { tabId: "B", left: 52, width: 80 },
  { tabId: "C", left: 134, width: 30 },
];

describe("insertionIndex", () => {
  test("counts the others left of the centre, skipping the dragged slot", () => {
    // A dragged just past B's centre lands after B (index 1 among [B, C]).
    expect(insertionIndex(slots, 93, "A")).toBe(1);
    expect(insertionIndex(slots, 91, "A")).toBe(0);
    expect(insertionIndex(slots, 500, "A")).toBe(2);
  });

  test("a foreign drag counts every chip", () => {
    expect(insertionIndex(slots, 0)).toBe(0);
    expect(insertionIndex(slots, 100)).toBe(2);
  });
});

describe("chipShifts", () => {
  test("own strip: the dragged slot closes and a gap opens at the index", () => {
    // A moved to the end: B and C slide left by A's width + gap.
    const s = chipShifts({ slots, gap: 2 }, 2, { tabId: "A", width: 50 });
    expect(s.get("B")).toBe(-52);
    expect(s.get("C")).toBe(-52);
    expect(s.has("A")).toBe(false);
  });

  test("own strip at its own index: nothing moves", () => {
    const s = chipShifts({ slots, gap: 2 }, 1, { tabId: "B", width: 80 });
    expect(s.get("A")).toBe(0);
    expect(s.get("C")).toBe(0);
  });

  test("foreign strip: chips from the index on make room", () => {
    const s = chipShifts({ slots, gap: 2 }, 1, { width: 40 });
    expect(s.get("A")).toBe(0);
    expect(s.get("B")).toBe(42);
    expect(s.get("C")).toBe(42);
  });
});

describe("clampDraggedOffset", () => {
  test("holds the chip within the strip's chips", () => {
    expect(clampDraggedOffset(slots, "B", -100)).toBe(-52);
    expect(clampDraggedOffset(slots, "B", 100)).toBe(32);
    expect(clampDraggedOffset(slots, "B", 10)).toBe(10);
  });
});
