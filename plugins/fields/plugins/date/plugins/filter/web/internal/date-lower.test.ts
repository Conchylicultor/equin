import { describe, expect, it } from "bun:test";
import {
  lowersToMatch,
  testField,
} from "@plugins/primitives/plugins/data-view/web/testing";
import type { FilterFieldValue } from "@plugins/primitives/plugins/data-view/core";
import { withinRange } from "../../core";
import { dateLower } from "./date-lower";

// Use noon timestamps so local start-of-day truncation is unambiguous.
const jan10 = new Date("2026-01-10T12:00:00");
const jan15 = new Date("2026-01-15T12:00:00");
const jan20 = new Date("2026-01-20T12:00:00");
// The pinned clock relative anchors resolve against: 2026-01-15, noon local.
const NOW = jan15.getTime();

const keeps = (
  op: keyof typeof dateLower,
  operand: unknown,
  value: FilterFieldValue,
) => lowersToMatch({ lower: dateLower[op] }, "instant", operand, value, NOW);

/** A local day offset from the pinned `NOW`, at `hour`. */
function daysFromNow(n: number, hour = 12): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe("date operators lowered", () => {
  it("is (same day)", () => {
    expect(keeps("is", "2026-01-15", jan15)).toBe(true);
    expect(keeps("is", "2026-01-15", jan10)).toBe(false);
    expect(keeps("is", "", jan15)).toBe(true); // empty operand → keep
  });

  it("is covers the whole local day, both edges", () => {
    const start = new Date("2026-01-15T00:00:00");
    const end = new Date("2026-01-15T23:59:59.999");
    const next = new Date("2026-01-16T00:00:00");
    expect(keeps("is", "2026-01-15", start)).toBe(true);
    expect(keeps("is", "2026-01-15", end)).toBe(true);
    expect(keeps("is", "2026-01-15", next)).toBe(false);
  });

  it("is-before / is-after (day-granular, exclusive)", () => {
    expect(keeps("is-before", "2026-01-15", jan10)).toBe(true);
    expect(keeps("is-before", "2026-01-15", jan15)).toBe(false);
    expect(keeps("is-after", "2026-01-15", jan20)).toBe(true);
    expect(keeps("is-after", "2026-01-15", jan15)).toBe(false);
  });

  it("is-on-or-before / is-on-or-after (inclusive)", () => {
    expect(keeps("is-on-or-before", "2026-01-15", jan15)).toBe(true);
    expect(keeps("is-on-or-before", "2026-01-15", jan20)).toBe(false);
    expect(keeps("is-on-or-after", "2026-01-15", jan15)).toBe(true);
    expect(keeps("is-on-or-after", "2026-01-15", jan10)).toBe(false);
  });

  it("is-between (inclusive, open bounds)", () => {
    const between = (operand: unknown, value: Date) =>
      keeps("is-between", operand, value);
    expect(between({ from: "2026-01-10", to: "2026-01-20" }, jan15)).toBe(true);
    expect(between({ from: "2026-01-10", to: "2026-01-20" }, jan10)).toBe(true);
    expect(between({ from: "2026-01-10", to: "2026-01-20" }, jan20)).toBe(true);
    expect(between({ from: "2026-01-16", to: "2026-01-20" }, jan15)).toBe(
      false,
    );
    expect(between({ from: "2026-01-12" }, jan15)).toBe(true);
    expect(between({ to: "2026-01-12" }, jan15)).toBe(false);
    expect(between({}, jan15)).toBe(true); // no bounds → keep
    expect(
      dateLower["is-between"](
        {},
        { column: "at", field: testField("at"), now: NOW },
      ),
    ).toBeUndefined();
  });

  it("non-date field → drop (when operand present)", () => {
    expect(keeps("is", "2026-01-15", null)).toBe(false);
    expect(keeps("is-before", "2026-01-15", undefined)).toBe(false);
    expect(keeps("is", "2026-01-15", "not a date")).toBe(false);
  });

  it("accepts epoch-ms and ISO-string field values (the adapter)", () => {
    expect(keeps("is", "2026-01-15", jan15.getTime())).toBe(true);
    expect(keeps("is", "2026-01-15", jan15.toISOString())).toBe(true);
  });

  it("is-empty / is-not-empty", () => {
    expect(keeps("is-empty", undefined, null)).toBe(true);
    expect(keeps("is-empty", undefined, jan15)).toBe(false);
    expect(keeps("is-not-empty", undefined, jan15)).toBe(true);
    expect(keeps("is-not-empty", undefined, undefined)).toBe(false);
  });

  it("accepts {kind:'date'} and {kind:'relative'} anchors", () => {
    // Absolute anchor resolves like a bare string.
    expect(keeps("is", { kind: "date", iso: "2026-01-15" }, jan15)).toBe(true);
    expect(keeps("is-before", { kind: "date", iso: "2026-01-15" }, jan10)).toBe(
      true,
    );
    // Relative "Today" resolves against the pinned clock.
    const today = { kind: "relative", unit: "day", amount: 0 };
    expect(keeps("is-before", today, jan10)).toBe(true);
    expect(keeps("is", today, jan15)).toBe(true);
    expect(
      keeps("is", { kind: "relative", unit: "day", amount: -5 }, jan10),
    ).toBe(true);
    // is-between accepts mixed absolute + relative bounds.
    expect(
      keeps(
        "is-between",
        { from: "2026-01-10", to: { kind: "date", iso: "2026-01-20" } },
        jan15,
      ),
    ).toBe(true);
  });

  it("reads the clock only for a relative anchor", () => {
    let reads = 0;
    const ctx = {
      column: "at",
      field: testField("at"),
      get now() {
        reads += 1;
        return NOW;
      },
    };
    dateLower.is("2026-01-15", ctx);
    dateLower["is-between"]({ from: { kind: "date", iso: "2026-01-10" } }, ctx);
    dateLower["is-within-past"]({ unit: "week" }, ctx); // incomplete
    expect(reads).toBe(0);
    dateLower.is({ kind: "relative", unit: "day", amount: 0 }, ctx);
    dateLower["is-within-past"]({ unit: "week", amount: 1 }, ctx);
    expect(reads).toBe(2);
  });
});

describe("withinRange (pinned now)", () => {
  const dayMs = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  it("past window is [today - N, today]", () => {
    expect(withinRange({ unit: "week", amount: 1 }, "past", NOW)).toEqual([
      dayMs("2026-01-08"),
      dayMs("2026-01-15"),
    ]);
    expect(withinRange({ unit: "day", amount: 3 }, "past", NOW)).toEqual([
      dayMs("2026-01-12"),
      dayMs("2026-01-15"),
    ]);
  });

  it("next window is [today, today + N]", () => {
    expect(withinRange({ unit: "week", amount: 2 }, "next", NOW)).toEqual([
      dayMs("2026-01-15"),
      dayMs("2026-01-29"),
    ]);
  });

  it("missing / non-positive operand → null (incomplete)", () => {
    expect(withinRange(undefined, "past", NOW)).toBe(null);
    expect(withinRange({}, "past", NOW)).toBe(null);
    expect(withinRange({ unit: "week", amount: 0 }, "past", NOW)).toBe(null);
  });
});

describe("is-within-past / is-within-next", () => {
  const week = { unit: "week", amount: 1 };

  it("is-within-past keeps fields within the past window", () => {
    expect(keeps("is-within-past", week, daysFromNow(0))).toBe(true);
    expect(keeps("is-within-past", week, daysFromNow(-3))).toBe(true);
    expect(keeps("is-within-past", week, daysFromNow(-7, 0))).toBe(true);
    expect(keeps("is-within-past", week, daysFromNow(-30))).toBe(false);
    expect(keeps("is-within-past", week, daysFromNow(3))).toBe(false);
  });

  it("is-within-next keeps fields within the next window", () => {
    expect(keeps("is-within-next", week, daysFromNow(0))).toBe(true);
    expect(keeps("is-within-next", week, daysFromNow(3))).toBe(true);
    expect(keeps("is-within-next", week, daysFromNow(7, 23))).toBe(true);
    expect(keeps("is-within-next", week, daysFromNow(30))).toBe(false);
    expect(keeps("is-within-next", week, daysFromNow(-3))).toBe(false);
  });

  it("incomplete operand → keep; null field → drop", () => {
    expect(keeps("is-within-past", undefined, daysFromNow(0))).toBe(true);
    expect(keeps("is-within-next", {}, daysFromNow(0))).toBe(true);
    expect(keeps("is-within-past", week, null)).toBe(false);
  });
});
