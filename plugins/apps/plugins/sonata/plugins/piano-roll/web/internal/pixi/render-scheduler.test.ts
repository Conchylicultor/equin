import { expect, test } from "bun:test";
import {
  createRenderScheduler,
  type SchedulerTicker,
} from "./render-scheduler";

/** A manual ticker: `frame()` runs the tick once, only while started. */
function fakeTicker() {
  let tick: (() => void) | null = null;
  const t: SchedulerTicker & { frame(): boolean; starts: number } = {
    started: false,
    deltaMS: 16,
    starts: 0,
    add(fn) {
      tick = fn;
    },
    remove() {
      tick = null;
    },
    start() {
      t.started = true;
      t.starts++;
    },
    stop() {
      t.started = false;
    },
    frame() {
      if (!t.started || !tick) return false;
      tick();
      return true;
    },
  };
  return t;
}

test("idle scheduler never starts the ticker", () => {
  const t = fakeTicker();
  createRenderScheduler(t);
  expect(t.started).toBe(false);
});

test("a request draws a frame; the loop lingers one more, then stops", () => {
  // The linger keeps a request-per-frame stream (playback) on one continuous
  // ticker run instead of a stop/start per frame (start resets the delta).
  const t = fakeTicker();
  const s = createRenderScheduler(t);
  s.request();
  expect(t.started).toBe(true);
  t.frame();
  expect(t.started).toBe(true);
  t.frame();
  expect(t.started).toBe(false);
  expect(t.starts).toBe(1);
});

test("requests every frame keep the loop alive (playback)", () => {
  const t = fakeTicker();
  const s = createRenderScheduler(t);
  for (let i = 0; i < 5; i++) {
    s.request();
    t.frame();
    expect(t.started).toBe(true);
  }
  t.frame();
  expect(t.started).toBe(false);
});

test("an animating updater holds the loop until it settles", () => {
  const t = fakeTicker();
  const s = createRenderScheduler(t);
  let left = 3;
  s.onFrame((dt) => {
    expect(dt).toBeCloseTo(0.016);
    return --left > 0;
  });
  s.request();
  let frames = 0;
  while (t.frame()) frames++;
  expect(frames).toBe(3);
  expect(t.started).toBe(false);
});

test("an unregistered updater no longer holds the loop; halt ignores requests", () => {
  const t = fakeTicker();
  const s = createRenderScheduler(t);
  const off = s.onFrame(() => true);
  off();
  s.request();
  t.frame();
  t.frame();
  expect(t.started).toBe(false);
  s.halt();
  s.request();
  expect(t.started).toBe(false);
});
