import { describe, expect, test } from "bun:test";
import { matchItem } from "./match-item";

const ITEMS = ["P0", "P1", "P2"];

describe("matchItem", () => {
  test("matches exactly, case-insensitively", () => {
    expect(matchItem("P1", ITEMS)).toEqual({ ok: true, item: "P1" });
    expect(matchItem("p1", ITEMS)).toEqual({ ok: true, item: "P1" });
  });

  test("strips quotes and trailing punctuation the model adds", () => {
    expect(matchItem('  "P0".  ', ITEMS)).toEqual({ ok: true, item: "P0" });
    expect(matchItem("`P2`", ITEMS)).toEqual({ ok: true, item: "P2" });
  });

  test("falls through prefix then substring", () => {
    expect(matchItem("P0 — revenue impacting", ITEMS)).toEqual({
      ok: true,
      item: "P0",
    });
    expect(matchItem("I would say P2 here", ITEMS)).toEqual({
      ok: true,
      item: "P2",
    });
  });

  test("an unmatched answer is a failure, never the last item", () => {
    const result = matchItem("Critical", ITEMS);
    expect(result.ok).toBe(false);
    // The pre-multi-category version returned the last configured label here.
    // That fabricated a classification, so it must not come back.
    expect(result).not.toEqual({ ok: true, item: "P2" });
  });

  test("an empty answer is a failure", () => {
    expect(matchItem("   ", ITEMS).ok).toBe(false);
  });

  test("a category with no items can never match", () => {
    expect(matchItem("P0", []).ok).toBe(false);
  });
});
