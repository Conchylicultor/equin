import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimsResizeLoopError,
  installResizeLoopTrace,
  resizeLoopReportSink,
  type ResizeLoopReport,
} from "../internal/resize-loop-trace";

const LOOP = "ResizeObserver loop completed with undelivered notifications.";

// A native observer the test delivers to by hand: deliver(observer, el, w, h)
// runs its callback as the browser would in a rendering step.
class FakeNativeObserver {
  static all: FakeNativeObserver[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    FakeNativeObserver.all.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function deliver(
  index: number,
  target: Element,
  width: number,
  height: number,
) {
  const native = FakeNativeObserver.all[index]!;
  const entry = {
    target,
    contentRect: { width, height },
  } as ResizeObserverEntry;
  native.callback([entry], native as unknown as ResizeObserver);
}

function raiseLoop() {
  window.dispatchEvent(new ErrorEvent("error", { message: LOOP }));
}

let uninstall: () => void;
let reports: ResizeLoopReport[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeNativeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16),
  );
  FakeNativeObserver.all = [];
  reports = [];
  resizeLoopReportSink.register((r) => reports.push(r));
  uninstall = installResizeLoopTrace();
});

afterEach(() => {
  uninstall();
  resizeLoopReportSink.register(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("installResizeLoopTrace", () => {
  it("reports the step that raised the loop and the notifications held back to the next frame", () => {
    const inner = document.createElement("div");
    const outer = document.createElement("section");
    outer.appendChild(inner);
    document.body.appendChild(outer);
    const calls: Element[] = [];
    new ResizeObserver((entries) => calls.push(entries[0]!.target));
    new ResizeObserver(() => {});

    deliver(0, inner, 10, 20); // the step's callback
    raiseLoop();
    deliver(1, outer, 30, 40); // next frame: the held-back notification
    vi.advanceTimersByTime(40);

    expect(calls).toEqual([inner]); // the page's callback still runs
    expect(reports).toHaveLength(1);
    const [r] = reports;
    expect(r!.message).toBe(LOOP);
    expect(r!.pass.map((o) => o.entries[0]!.target)).toEqual([inner]);
    expect(r!.pass[0]!.entries[0]).toMatchObject({ width: 10, height: 20 });
    expect(r!.deferred.map((o) => o.entries[0]!.target)).toEqual([outer]);
    expect(r!.pass[0]!.site).toContain("resize-loop-trace.test.ts");
    outer.remove();
  });

  it("keeps only the current step's callbacks", () => {
    const el = document.createElement("div");
    new ResizeObserver(() => {});
    deliver(0, el, 1, 1);
    vi.advanceTimersByTime(1); // the step ends
    raiseLoop();
    vi.advanceTimersByTime(40);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.pass).toEqual([]);
  });

  it("claims the loop errors it reports, and only while installed", () => {
    const loop = new ErrorEvent("error", { message: LOOP });
    const other = new ErrorEvent("error", { message: "boom" });
    window.dispatchEvent(loop);
    window.dispatchEvent(other);
    expect(claimsResizeLoopError(loop)).toBe(true);
    expect(claimsResizeLoopError(other)).toBe(false);
    vi.advanceTimersByTime(40);
    expect(reports).toHaveLength(1);
    uninstall();
    const after = new ErrorEvent("error", { message: LOOP });
    window.dispatchEvent(after);
    expect(claimsResizeLoopError(after)).toBe(false);
    uninstall = installResizeLoopTrace();
  });
});
