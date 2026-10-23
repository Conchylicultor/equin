import { describe, expect, test } from "bun:test";
import { defineHintAnchor } from "../../core/internal/anchors";
import { defineHint } from "../../core/internal/declarations";
import {
  activeTip,
  emptyTipQueue,
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
  test("waits out the settle window, then shows the lowest order first", () => {
    let q = requestTip(emptyTipQueue, main, 0);
    q = requestTip(q, tryIt, 100);
    expect(wakeAt(q)).toBe(SETTLE_MS);
    expect(activeTip(stepTips(q, SETTLE_MS - 1, all))).toBeNull();
    q = stepTips(q, SETTLE_MS, all);
    expect(activeTip(q)?.id).toBe("try-it");
  });

  test("equal orders go to whichever asked first", () => {
    const a = defineHint({ id: "a", anchor, title: "", body: "" });
    const b = defineHint({ id: "b", anchor, title: "", body: "" });
    let q = requestTip(requestTip(emptyTipQueue, b, 0), a, 0);
    q = stepTips(q, SETTLE_MS, all);
    expect(q.active).toBe("b");
  });

  test("shows one at a time; the next after an answer, after a fresh window", () => {
    let q = requestTip(requestTip(emptyTipQueue, tryIt, 0), main, 0);
    q = stepTips(q, SETTLE_MS, all);
    expect(q.active).toBe("try-it");
    // A request arriving while one shows does not reopen the window.
    expect(wakeAt(q)).toBeNull();
    q = removeTip(q, "try-it", 1000);
    expect(q.active).toBeNull();
    expect(stepTips(q, 1000, all).active).toBeNull();
    q = stepTips(q, 1000 + SETTLE_MS, all);
    expect(q.active).toBe("main");
  });

  test("withdrawing a waiting request drops it without showing", () => {
    let q = requestTip(emptyTipQueue, tryIt, 0);
    q = removeTip(q, "try-it", 10);
    expect(stepTips(q, SETTLE_MS, all).active).toBeNull();
    expect(q.requests).toHaveLength(0);
  });

  test("withdrawing the active tip hides it", () => {
    let q = stepTips(requestTip(emptyTipQueue, tryIt, 0), SETTLE_MS, all);
    q = removeTip(q, "try-it", 800);
    expect(activeTip(q)).toBeNull();
    expect(q.settleFrom).toBeNull();
  });

  test("nothing shows while nothing is eligible (seen state pending); shows once it is", () => {
    let q = requestTip(emptyTipQueue, tryIt, 0);
    q = stepTips(q, SETTLE_MS * 3, () => false);
    expect(q.active).toBeNull();
    expect(q.settleFrom).toBe(0);
    q = stepTips(q, SETTLE_MS * 3, all);
    expect(q.active).toBe("try-it");
  });

  test("an active tip that stops being eligible is hidden and the window reopens", () => {
    let q = requestTip(requestTip(emptyTipQueue, tryIt, 0), main, 0);
    q = stepTips(q, SETTLE_MS, all);
    q = stepTips(q, 2000, (h) => h.id !== "try-it");
    expect(q.active).toBeNull();
    expect(q.settleFrom).toBe(2000);
    expect(stepTips(q, 2000 + SETTLE_MS, (h) => h.id !== "try-it").active).toBe(
      "main",
    );
  });

  test("a repeated request is idempotent", () => {
    const q = requestTip(requestTip(emptyTipQueue, tryIt, 0), tryIt, 5);
    expect(q.requests).toHaveLength(1);
  });
});
