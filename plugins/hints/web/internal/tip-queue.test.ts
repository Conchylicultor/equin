import { describe, expect, test } from "bun:test";
import { defineHintAnchor } from "../../core/internal/anchors";
import { defineHint } from "../../core/internal/declarations";
import {
  activeRequest,
  activeTip,
  emptyTipQueue,
  ORIENT_MS,
  QUIET_MS,
  removeTip,
  requestTip,
  SETTLE_MS,
  stepTips,
  wakeAt,
} from "./tip-queue";

const anchor = defineHintAnchor("test.anchor");
const tryIt = defineHint({
  id: "try-it",
  anchor,
  title: "Try it",
  body: "",
  order: 1,
});
const main = defineHint({
  id: "main",
  anchor,
  title: "Main",
  body: "",
  order: 2,
});
const all = () => true;

describe("tip queue", () => {
  test("waits out the orientation window, then shows the lowest order first", () => {
    let q = requestTip(emptyTipQueue, main, 0);
    q = requestTip(q, tryIt, 100);
    expect(wakeAt(q)).toBe(ORIENT_MS);
    expect(activeTip(stepTips(q, ORIENT_MS - 1, all))).toBeNull();
    q = stepTips(q, ORIENT_MS, all);
    expect(activeTip(q)?.id).toBe("try-it");
  });

  test("equal orders go to whichever asked first", () => {
    const a = defineHint({ id: "a", anchor, title: "", body: "" });
    const b = defineHint({ id: "b", anchor, title: "", body: "" });
    let q = requestTip(requestTip(emptyTipQueue, b, 0), a, 0);
    q = stepTips(q, ORIENT_MS, all);
    expect(q.active).toBe("b");
  });

  test("shows one at a time; the next after an answer, after a short window", () => {
    let q = requestTip(requestTip(emptyTipQueue, tryIt, 0), main, 0);
    q = stepTips(q, ORIENT_MS, all);
    expect(q.active).toBe("try-it");
    // A request arriving while one shows does not reopen the window.
    expect(wakeAt(q)).toBeNull();
    q = removeTip(q, "try-it", 3000);
    expect(q.active).toBeNull();
    expect(stepTips(q, 3000, all).active).toBeNull();
    q = stepTips(q, 3000 + SETTLE_MS, all);
    expect(q.active).toBe("main");
  });

  test("withdrawing a waiting request drops it without showing", () => {
    let q = requestTip(emptyTipQueue, tryIt, 0);
    q = removeTip(q, "try-it", 10);
    expect(stepTips(q, ORIENT_MS, all).active).toBeNull();
    expect(q.requests).toHaveLength(0);
  });

  test("withdrawing the active tip hides it", () => {
    let q = stepTips(requestTip(emptyTipQueue, tryIt, 0), ORIENT_MS, all);
    q = removeTip(q, "try-it", 3000);
    expect(activeTip(q)).toBeNull();
    expect(q.readyAt).toBeNull();
  });

  test("nothing shows while nothing is eligible (seen state pending); shows once it is", () => {
    let q = requestTip(emptyTipQueue, tryIt, 0);
    q = stepTips(q, ORIENT_MS * 3, () => false);
    expect(q.active).toBeNull();
    expect(q.readyAt).toBe(ORIENT_MS);
    q = stepTips(q, ORIENT_MS * 3, all);
    expect(q.active).toBe("try-it");
  });

  test("an active tip that stops being eligible is hidden and the window reopens", () => {
    let q = requestTip(requestTip(emptyTipQueue, tryIt, 0), main, 0);
    q = stepTips(q, ORIENT_MS, all);
    q = stepTips(q, 4000, (h) => h.id !== "try-it");
    expect(q.active).toBeNull();
    expect(q.readyAt).toBe(4000 + SETTLE_MS);
    expect(stepTips(q, 4000 + SETTLE_MS, (h) => h.id !== "try-it").active).toBe(
      "main",
    );
  });

  test("a tip waits for the user to pause: input inside QUIET_MS defers it", () => {
    const q = requestTip(emptyTipQueue, tryIt, 0);
    // The user is still moving just before the window ends.
    const movedAt = ORIENT_MS - 100;
    expect(wakeAt(q, movedAt)).toBe(movedAt + QUIET_MS);
    expect(stepTips(q, ORIENT_MS, all, movedAt).active).toBeNull();
    expect(stepTips(q, movedAt + QUIET_MS, all, movedAt).active).toBe("try-it");
    // Input long before the window ends does not push it back.
    expect(wakeAt(q, 0)).toBe(ORIENT_MS);
  });

  test("a request arriving while another waits keeps the window", () => {
    let q = requestTip(emptyTipQueue, main, 0);
    q = requestTip(q, tryIt, 2000);
    expect(wakeAt(q)).toBe(ORIENT_MS);
  });

  test("a repeated request is idempotent", () => {
    const q = requestTip(requestTip(emptyTipQueue, tryIt, 0), tryIt, 5);
    expect(q.requests).toHaveLength(1);
  });

  test("the same tip asked from the page and from a scope is two requests, each with its own scope", () => {
    let q = requestTip(emptyTipQueue, tryIt, 0);
    q = requestTip(q, tryIt, 0, "demo");
    expect(q.requests.map((r) => [r.scope, r.key])).toEqual([
      [null, "try-it"],
      ["demo", "demo\u0000try-it"],
    ]);
    // Only the demo's is eligible (the page's is seen): the demo's shows.
    q = stepTips(q, ORIENT_MS, (_h, r) => r.scope === "demo");
    expect(activeRequest(q)?.scope).toBe("demo");
    // Answering it leaves the page's request waiting.
    q = removeTip(q, "demo\u0000try-it", 1000);
    expect(q.requests.map((r) => r.scope)).toEqual([null]);
  });
});
