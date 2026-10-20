import { describe, expect, test } from "bun:test";
import {
  followAction,
  isAtBottom,
  nextMode,
  resolveRestore,
  sentinelObserverOptions,
  type PersistedMode,
  type ScrollMode,
} from "./sticky-scroll-machine";

const following: ScrollMode = { kind: "following" };
const anchored: ScrollMode = { kind: "anchored" };

describe("nextMode", () => {
  test("jump always resumes following", () => {
    expect(nextMode({ t: "jump" })).toEqual(following);
    expect(nextMode({ t: "jump" })).toEqual(following);
  });

  test("followKey change always resumes following", () => {
    expect(nextMode({ t: "follow-key" })).toEqual(following);
  });

  test("a foreign scroll arriving at the bottom resumes following", () => {
    expect(
      nextMode({
        t: "foreign-scroll",
        sentinelVisible: true,
        movedUp: false,
        atEnd: false,
      }),
    ).toEqual(following);
  });

  test("a foreign scroll away from the bottom parks", () => {
    expect(
      nextMode({
        t: "foreign-scroll",
        sentinelVisible: false,
        movedUp: true,
        atEnd: false,
      }),
    ).toEqual(anchored);
  });

  test("moving up parks even while still inside the bottom threshold", () => {
    // The regression this exists for: a smooth scroll leaving the bottom starts
    // within the threshold, so position alone says "you are at the bottom" and
    // the follow loop drags the user back, cancelling the navigation.
    expect(
      nextMode({
        t: "foreign-scroll",
        sentinelVisible: true,
        movedUp: true,
        atEnd: false,
      }),
    ).toEqual(anchored);
  });

  test("a clamp to the end (content shrank below) keeps following", () => {
    // Measured on a live transcript: the hook wrote the bottom, a tool card
    // then shrank as its result landed, and the browser clamped the offset
    // up — a scroll that moved up and was not ours. It is not the reader
    // leaving: a reader moving up cannot land at the maximum offset.
    expect(
      nextMode({
        t: "foreign-scroll",
        sentinelVisible: true,
        movedUp: true,
        atEnd: true,
      }),
    ).toEqual(following);
  });

  test("moving down but not yet at the bottom stays parked", () => {
    expect(
      nextMode({
        t: "foreign-scroll",
        sentinelVisible: false,
        movedUp: false,
        atEnd: false,
      }),
    ).toEqual(anchored);
  });
});

describe("followAction — the 2026-05-25 guarantee", () => {
  test("never writes while parked, whatever the sentinel does", () => {
    // This is the file-pane bug: content reflows taller, the bottom leaves the
    // viewport. A size-based hook read that as "new content" and scrolled.
    expect(followAction(anchored, false)).toBe("none");
    expect(followAction(anchored, true)).toBe("none");
  });

  test("chases the bottom only while following and only when off screen", () => {
    expect(followAction(following, false)).toBe("scroll-to-bottom");
    expect(followAction(following, true)).toBe("none");
  });
});

describe("isAtBottom", () => {
  const at = (scrollTop: number) =>
    isAtBottom({ scrollHeight: 1000, scrollTop, clientHeight: 400 }, 50);

  test("true within the threshold of the end", () => {
    expect(at(600)).toBe(true); // exactly at the bottom
    expect(at(560)).toBe(true); // 40px short
    expect(at(550)).toBe(true); // exactly threshold
  });

  test("false beyond the threshold", () => {
    expect(at(549)).toBe(false);
    expect(at(0)).toBe(false);
  });

  test("content shorter than the viewport is always at the bottom", () => {
    expect(
      isAtBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 }, 50),
    ).toBe(true);
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
