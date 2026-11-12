import { describe, expect, test } from "bun:test";
import { KEPT_HIDDEN_TABS, nextRecency, residentTabs } from "./tab-residency";

describe("nextRecency", () => {
  test("moves the focused tab to the front", () => {
    expect(nextRecency(["a", "b", "c"], new Set(["a", "b", "c"]), "c")).toEqual(
      ["c", "a", "b"],
    );
  });

  test("adds a tab focused for the first time", () => {
    expect(nextRecency(["a"], new Set(["a", "b"]), "b")).toEqual(["b", "a"]);
  });

  test("drops tabs no longer rendered", () => {
    expect(nextRecency(["a", "b", "c"], new Set(["a", "c"]), "a")).toEqual([
      "a",
      "c",
    ]);
  });

  test("returns the same list when nothing changed, so the render settles", () => {
    const recent = ["a", "b"];
    expect(nextRecency(recent, new Set(["a", "b"]), "a")).toBe(recent);
  });

  test("an empty surface keeps the remaining order", () => {
    expect(nextRecency(["a", "b"], new Set(["b"]), undefined)).toEqual(["b"]);
  });
});

describe("residentTabs", () => {
  const focusedOnly = (focused: string) => (id: string) => id === focused;

  test("keeps the focused tab and the most recent hidden ones", () => {
    const recent = ["e", "d", "c", "b", "a"];
    const resident = residentTabs(
      recent,
      ["a", "b", "c", "d", "e"],
      focusedOnly("e"),
    );
    expect([...resident].sort()).toEqual(
      recent.slice(0, 1 + KEPT_HIDDEN_TABS).sort(),
    );
  });

  test("a tab never focused on this surface is unloaded when hidden", () => {
    // A reload: only the focused tab is in the recency list.
    const resident = residentTabs(["b"], ["a", "b", "c"], focusedOnly("b"));
    expect([...resident]).toEqual(["b"]);
  });

  test("every tab on screen is resident, whatever its recency", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const resident = residentTabs(["a"], ids, () => true);
    expect([...resident].sort()).toEqual(ids);
  });

  test("on-screen tabs do not use up the hidden budget", () => {
    // Windows mode: a, b on screen; c, d, e hidden (minimised / never shown).
    const onScreen = (id: string) => id === "a" || id === "b";
    const resident = residentTabs(
      ["a", "b", "c", "d", "e"],
      ["a", "b", "c", "d", "e"],
      onScreen,
    );
    expect(resident.size).toBe(2 + KEPT_HIDDEN_TABS);
    expect(resident.has("c")).toBe(true);
  });
});
