import { describe, expect, test } from "bun:test";
import {
  distanceToBottom,
  followAction,
  resolveRestore,
  sentinelObserverOptions,
  step,
  type PersistedMode,
  type ScrollMode,
  type StickySignal,
} from "./sticky-scroll-machine";

const following: ScrollMode = { kind: "following" };
const driving: ScrollMode = { kind: "driving" };
const anchored: ScrollMode = { kind: "anchored" };
const T = 50;

const scroll = (
  p: Partial<Extract<StickySignal, { t: "scroll" }>>,
): StickySignal => ({
  t: "scroll",
  ours: false,
  armed: false,
  movedDown: false,
  distance: 0,
  ...p,
});

describe("step — reader scrolls", () => {
  test("jump and followKey resume following and write the bottom", () => {
    for (const mode of [following, driving, anchored]) {
      expect(step(mode, { t: "jump" }, T)).toEqual({
        mode: following,
        action: "scroll-to-bottom",
      });
      expect(step(mode, { t: "follow-key" }, T).mode).toEqual(following);
    }
  });

  test("an armed scroll up from the bottom drives, and writes nothing", () => {
    // Even inside the margin: a smooth navigation leaving the bottom starts
    // within it, and a write would cancel it.
    expect(step(following, scroll({ armed: true, distance: 10 }), T)).toEqual({
      mode: driving,
      action: "none",
    });
  });

  test("settling inside the margin sticks; beyond it parks", () => {
    expect(step(driving, { t: "settle", distance: 30 }, T)).toEqual({
      mode: following,
      action: "scroll-to-bottom",
    });
    expect(step(driving, { t: "settle", distance: 400 }, T)).toEqual({
      mode: anchored,
      action: "none",
    });
  });

  test("an armed scroll arriving at the bottom resumes at once", () => {
    expect(
      step(anchored, scroll({ armed: true, movedDown: true, distance: 20 }), T),
    ).toEqual({ mode: following, action: "none" });
  });

  test("an armed scroll down that stops short drives, then parks", () => {
    const s = step(
      anchored,
      scroll({ armed: true, movedDown: true, distance: 300 }),
      T,
    );
    expect(s.mode).toEqual(driving);
    expect(step(s.mode, { t: "settle", distance: 300 }, T).mode).toEqual(
      anchored,
    );
  });

  test("while driving every scroll is the reader's (momentum after the input)", () => {
    expect(step(driving, scroll({ distance: 500 }), T).mode).toEqual(driving);
  });

  test("find parks", () => {
    expect(step(following, { t: "find" }, T).mode).toEqual(anchored);
  });
});

describe("step — nothing but reader evidence stops following", () => {
  test("a scroll nobody asked for is put back at the bottom", () => {
    // The clamp as a card collapses, browser anchoring, KeepAnchorAcross
    // keeping a row across a window slide, a focus() — all of them.
    expect(step(following, scroll({ distance: 240 }), T)).toEqual({
      mode: following,
      action: "scroll-to-bottom",
    });
    expect(step(following, scroll({ distance: 0 }), T)).toEqual({
      mode: following,
      action: "none",
    });
  });

  test("no sequence of non-reader signals ever leaves following", () => {
    const signals: StickySignal[] = [
      { t: "sentinel", visible: true },
      { t: "sentinel", visible: false },
      { t: "settle", distance: 0 },
      { t: "settle", distance: 900 },
      scroll({ ours: true, distance: 0 }),
      scroll({ ours: true, distance: 700 }),
      scroll({ distance: 0 }),
      scroll({ distance: 30 }),
      scroll({ distance: 700 }),
      scroll({ movedDown: true, distance: 30 }),
      scroll({ movedDown: true, distance: 700 }),
    ];
    const walk = (mode: ScrollMode, depth: number) => {
      expect(mode).toEqual(following);
      if (depth === 0) return;
      for (const signal of signals) walk(step(mode, signal, T).mode, depth - 1);
    };
    walk(following, 5);
  });

  test("no observation writes while not following (2026-05-25)", () => {
    // The file-pane bug: content reflows taller, the bottom leaves the
    // viewport. A size-based hook read that as "new content" and scrolled.
    for (const mode of [driving, anchored]) {
      for (const visible of [true, false])
        expect(step(mode, { t: "sentinel", visible }, T).action).toBe("none");
      for (const distance of [0, 30, 700])
        expect(step(mode, scroll({ distance }), T).action).toBe("none");
    }
    expect(followAction(anchored, false)).toBe("none");
    expect(followAction(following, false)).toBe("scroll-to-bottom");
    expect(followAction(following, true)).toBe("none");
  });

  test("a parked reader stays parked through scrolls nobody asked for", () => {
    for (const distance of [0, 30, 700])
      expect(step(anchored, scroll({ distance }), T).mode).toEqual(anchored);
  });
});

describe("distanceToBottom", () => {
  const at = (scrollTop: number) =>
    distanceToBottom({ scrollHeight: 1000, scrollTop, clientHeight: 400 });

  test("measures how far the end is below the viewport", () => {
    expect(at(600)).toBe(0);
    expect(at(560)).toBe(40);
    expect(at(0)).toBe(600);
  });

  test("content shorter than the viewport is at the bottom", () => {
    expect(
      distanceToBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 }),
    ).toBe(0);
  });
});

describe("sentinelObserverOptions", () => {
  // rootMargin is "top right bottom left".
  const parse = (threshold: number) =>
    sentinelObserverOptions(threshold).rootMargin.split(" ");

  test("carries the pin threshold as bottom rootMargin", () => {
    expect(parse(50)[2]).toBe("50px");
    expect(parse(32)[2]).toBe("32px");
    expect(sentinelObserverOptions(50).threshold).toBe(0);
  });

  test("never grows the root upward — only the bottom edge is the pin distance", () => {
    expect(parse(50)[0]).toBe("0px");
  });

  test("widens left and right so horizontal scroll can never drop the sentinel", () => {
    const [, right, , left] = parse(50);
    expect(Number.parseInt(right!, 10)).toBeGreaterThan(100_000);
    expect(left).toBe(right);
  });

  test("clamps a negative threshold rather than emitting invalid rootMargin", () => {
    expect(parse(-10)[2]).toBe("0px");
  });
});

describe("resolveRestore", () => {
  const el = {} as HTMLElement;
  const found = () => el;
  const gone = () => null;
  const savedAnchor: PersistedMode = { kind: "anchored", key: "tool:abc" };

  test("nothing saved is `none`", () => {
    expect(resolveRestore(null, found)).toEqual({ kind: "none" });
  });

  test("a saved following mode restores following", () => {
    expect(resolveRestore({ kind: "following" }, gone)).toEqual({
      kind: "following",
    });
  });

  test("a saved anchor that still exists resolves to the element", () => {
    expect(resolveRestore(savedAnchor, found)).toEqual({
      kind: "anchored",
      el,
    });
  });

  test("a saved anchor carries its offset into the row", () => {
    expect(resolveRestore({ ...savedAnchor, offset: -320 }, found)).toEqual({
      kind: "anchored",
      el,
      offset: -320,
    });
  });

  test("a saved anchor whose row is gone is `missing`, never `none`", () => {
    // Folding this into `none` would make a key-scheme regression across every
    // conversation look exactly like a first visit.
    expect(resolveRestore(savedAnchor, gone)).toEqual({
      kind: "missing",
      key: "tool:abc",
    });
  });
});
