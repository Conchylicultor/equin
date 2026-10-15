/**
 * The disclosure diff decides what folds — and, as importantly, what does NOT:
 * a list change only folds when an open key flipped on a row both lists draw.
 * Live inserts, a search, a scope change must land as they are.
 */

import { describe, expect, test } from "bun:test";
import {
  awaitedReveal,
  detectContinuation,
  detectDisclosure,
  withFoldingRows,
} from "./disclosure";

const key = (s: string) => s;
const open = (...keys: string[]) => new Set(keys);

describe("detectDisclosure", () => {
  test("an expand reveals the rows that appeared", () => {
    const d = detectDisclosure({
      prevItems: ["a", "b", "c"],
      nextItems: ["a", "a1", "a2", "b", "c"],
      prevOpen: open(),
      nextOpen: open("a"),
      getKey: key,
    });
    expect(d).not.toBeNull();
    expect([...d!.revealed]).toEqual(["a1", "a2"]);
    expect(d!.hidden).toEqual([]);
  });

  test("a collapse hides the rows that went, anchored after their survivor", () => {
    const d = detectDisclosure({
      prevItems: ["a", "a1", "a2", "b"],
      nextItems: ["a", "b"],
      prevOpen: open("a"),
      nextOpen: open(),
      getKey: key,
    });
    expect(d!.revealed.size).toBe(0);
    expect(d!.hidden).toEqual([
      { key: "a1", item: "a1", after: "a" },
      { key: "a2", item: "a2", after: "a" },
    ]);
  });

  test("a change with no flip is no disclosure (live data, search, paging)", () => {
    expect(
      detectDisclosure({
        prevItems: ["a", "b"],
        nextItems: ["a", "x", "b"],
        prevOpen: open("a"),
        nextOpen: open("a"),
        getKey: key,
      }),
    ).toBeNull();
  });

  test("a row inserted already open is live data, not a toggle", () => {
    expect(
      detectDisclosure({
        prevItems: ["a", "b"],
        nextItems: ["a", "b", "n", "n1"],
        prevOpen: open(),
        nextOpen: open("n"),
        getKey: key,
      }),
    ).toBeNull();
  });

  test("a flip of a key no row carries (a fold line, a group) still counts", () => {
    const d = detectDisclosure({
      prevItems: ["a", "b"],
      nextItems: ["a", "b", "c", "d"],
      prevOpen: open(),
      nextOpen: open("section:1"),
      getKey: key,
    });
    expect([...d!.revealed]).toEqual(["c", "d"]);
  });

  test("a toggle that changes nothing drawn is no disclosure", () => {
    expect(
      detectDisclosure({
        prevItems: ["a", "a1"],
        nextItems: ["a", "a1"].slice(),
        prevOpen: open("a"),
        nextOpen: open(),
        getKey: key,
      }),
    ).toBeNull();
  });
});

describe("withFoldingRows", () => {
  test("puts hidden rows back after their anchor, and leading ones first", () => {
    const d = {
      revealed: new Set<string>(),
      hidden: [
        { key: "z", item: "z", after: null },
        { key: "a1", item: "a1", after: "a" },
        { key: "a2", item: "a2", after: "a" },
      ],
    };
    expect(withFoldingRows(["a", "b"], d, key)).toEqual([
      "z",
      "a",
      "a1",
      "a2",
      "b",
    ]);
  });

  test("a hidden row back in the list is drawn once", () => {
    const d = {
      revealed: new Set<string>(),
      hidden: [{ key: "a1", item: "a1", after: "a" }],
    };
    expect(withFoldingRows(["a", "a1", "b"], d, key)).toEqual(["a", "a1", "b"]);
  });

  test("rows whose anchor live data removed stop drawing", () => {
    const d = {
      revealed: new Set<string>(),
      hidden: [{ key: "a1", item: "a1", after: "a" }],
    };
    expect(withFoldingRows(["b"], d, key)).toEqual(["b"]);
  });
});

describe("awaitedReveal", () => {
  const standIn = (k: string) =>
    k.endsWith(":loading") || k.endsWith(":footer");

  test("a line opened onto nothing but stand-ins awaits its rows", () => {
    const a = awaitedReveal({
      nextItems: ["a", "a:loading", "b"],
      prevOpen: open(),
      nextOpen: open("a"),
      revealed: new Set(["a:loading"]),
      getKey: key,
      isStandIn: standIn,
    });
    expect([...a.after]).toEqual(["a"]);
    expect([...a.standIns]).toEqual(["a:loading"]);
  });

  test("a line opened onto real rows awaits nothing", () => {
    const a = awaitedReveal({
      nextItems: ["a", "a1", "b"],
      prevOpen: open(),
      nextOpen: open("a"),
      revealed: new Set(["a1"]),
      getKey: key,
      isStandIn: standIn,
    });
    expect(a.after.size).toBe(0);
  });
});

describe("detectContinuation", () => {
  const standIn = (k: string) =>
    k.endsWith(":loading") || k.endsWith(":footer");
  const awaiting = (after: string[], standIns: string[]) => ({
    after: new Set(after),
    standIns: new Set(standIns),
  });

  test("children replacing a placeholder are the toggle's reveal arriving", () => {
    const step = detectContinuation({
      prevItems: ["a", "a:loading", "b"],
      nextItems: ["a", "a1", "a2", "b"],
      awaited: awaiting(["a"], ["a:loading"]),
      getKey: key,
      isStandIn: standIn,
    });
    expect([...step.disclosure!.revealed]).toEqual(["a1", "a2"]);
    expect(step.disclosure!.hidden).toEqual([
      { key: "a:loading", item: "a:loading", after: "a" },
    ]);
    expect(step.awaited.after.size).toBe(0);
  });

  test("rows landing above a section's footer are its reveal", () => {
    const step = detectContinuation({
      prevItems: ["g", "g:footer", "h"],
      nextItems: ["g", "g1", "g2", "g:footer", "h"],
      awaited: awaiting(["g"], ["g:footer"]),
      getKey: key,
      isStandIn: standIn,
    });
    expect([...step.disclosure!.revealed]).toEqual(["g1", "g2"]);
    expect(step.disclosure!.hidden).toEqual([]);
  });

  test("live data elsewhere neither folds nor ends the wait", () => {
    const step = detectContinuation({
      prevItems: ["g", "h", "h1"],
      nextItems: ["g", "h", "h0", "h1"],
      awaited: awaiting(["g"], []),
      getKey: key,
      isStandIn: standIn,
    });
    expect(step.disclosure).toBeNull();
    expect([...step.awaited.after]).toEqual(["g"]);
  });

  test("a stand-in arriving first keeps the line waiting for its rows", () => {
    const step = detectContinuation({
      prevItems: ["g", "h"],
      nextItems: ["g", "g:footer", "h"],
      awaited: awaiting(["g"], []),
      getKey: key,
      isStandIn: standIn,
    });
    expect([...step.disclosure!.revealed]).toEqual(["g:footer"]);
    expect([...step.awaited.after]).toEqual(["g"]);
    expect([...step.awaited.standIns]).toEqual(["g:footer"]);
  });
});
