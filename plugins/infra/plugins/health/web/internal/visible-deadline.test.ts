import { describe, expect, test } from "bun:test";
import { createVisibleDeadlines, MAX_HIDDEN_PERIODS } from "./visible-deadline";

// A hand-driven clock + timer queue + visibility flag.
function harness() {
  let now = 1_000;
  let hidden = false;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const d = createVisibleDeadlines({
    now: () => now,
    isHidden: () => hidden,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  });
  // Advance the clock; when `frozen`, timers do not run (a frozen page),
  // and they all fire at once on the next unfrozen advance.
  const advance = (ms: number, frozen = false) => {
    now += ms;
    if (frozen) return;
    for (;;) {
      const due = [...timers].find(([, t]) => t.at <= now);
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return {
    d,
    advance,
    hide: () => {
      hidden = true;
      d.onHidden();
    },
    show: () => {
      hidden = false;
      d.onVisible();
    },
    thaw: () => {
      // Resume order on mobile is not guaranteed: timers may run before the
      // visibilitychange event.
      hidden = false;
    },
  };
}

describe("createVisibleDeadlines", () => {
  test("elapses after the window of continuous visible time", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(14_999);
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
  });

  test("cleared before the window, never fires", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(5_000);
    h.d.clear("a");
    h.advance(60_000);
    expect(fired).toBe(0);
  });

  test("re-arming an armed key keeps the first window", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(10_000);
    h.d.arm("a", 15_000, () => fired++);
    h.advance(5_000);
    expect(fired).toBe(1);
  });

  test("a timer firing while hidden parks, then counts on once visible", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(2_000); // 2 s visible
    h.hide();
    h.advance(60_000);
    expect(fired).toBe(0);
    h.show();
    h.advance(12_999); // 14.999 s visible in total
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
  });

  test("frozen page: overdue timers run on thaw before the visible event", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(1_000); // 1 s visible
    h.hide();
    h.advance(60_000, true); // frozen: nothing runs
    h.thaw();
    h.advance(0); // the overdue timer runs; page visible, event not yet fired
    expect(fired).toBe(0);
    h.d.onVisible();
    h.advance(13_999);
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
  });

  test("a brief hide only takes its own time out of the window", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    h.advance(5_000);
    h.hide();
    h.advance(3_000);
    h.show();
    h.advance(9_999); // 14.999 s visible
    expect(fired).toBe(0);
    h.advance(1);
    expect(fired).toBe(1);
  });

  test("frequent tab switches still add up to the window", () => {
    const h = harness();
    let fired = 0;
    h.d.arm("a", 15_000, () => fired++);
    for (let i = 0; i < 4; i++) {
      h.advance(4_000); // 4 s visible
      h.hide();
      h.advance(1_000);
      h.show();
    }
    expect(fired).toBe(1); // 16 s visible across four stretches
  });

  test("visibleMsSince: the window minus every hidden period inside it", () => {
    const h = harness();
    const start = 1_000;
    h.advance(5_000);
    expect(h.d.visibleMsSince(start)).toBe(5_000);
    h.hide();
    h.advance(2_000);
    expect(h.d.visibleMsSince(start)).toBe(5_000); // open period counts
    h.show();
    h.advance(1_000);
    expect(h.d.visibleMsSince(start)).toBe(6_000);
    // A window starting inside the hidden period counts only its tail.
    expect(h.d.visibleMsSince(start + 6_000)).toBe(1_000);
  });

  test("a long suspension leaves a short wait under its limit", () => {
    const h = harness();
    const waitStart = 1_000;
    h.advance(2_000);
    h.hide();
    h.advance(300_000); // phone locked 5 min
    h.show();
    h.advance(500);
    expect(h.d.visibleMsSince(waitStart)).toBe(2_500);
  });

  test("hidden-period overflow drops the oldest, erring towards visible", () => {
    const h = harness();
    const start = 1_000;
    for (let i = 0; i < MAX_HIDDEN_PERIODS + 1; i++) {
      h.hide();
      h.advance(10);
      h.show();
    }
    // One 10 ms period fell off: it counts as visible now.
    expect(h.d.visibleMsSince(start)).toBe(10);
  });
});
