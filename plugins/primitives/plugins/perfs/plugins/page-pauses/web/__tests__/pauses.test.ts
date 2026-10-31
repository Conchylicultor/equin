// The hidden rule every client latency consumer reads: how much of a span the
// page was hidden (or frozen) in — a stretch still in progress included.

import { afterEach, describe, expect, it, vi } from "vitest";
import { pausesDuring } from "../internal/pauses";

let visibility: DocumentVisibilityState = "visible";
vi.spyOn(document, "visibilityState", "get").mockImplementation(
  () => visibility,
);
function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

describe("pausesDuring — hidden", () => {
  it("a stretch in progress counts from its start, not before", () => {
    vi.useFakeTimers();
    vi.setSystemTime(500_000);
    setVisibility("hidden");
    vi.setSystemTime(500_100);
    expect(pausesDuring(499_990, 500_050).hiddenMs).toBe(50);
    // A span that ended before the tab was hidden is still a visible one.
    expect(pausesDuring(499_900, 499_990).hiddenMs).toBe(0);
  });

  it("a hidden stretch inside the span counts; one before it does not", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setVisibility("hidden");
    vi.setSystemTime(1_000_100);
    setVisibility("visible");
    vi.setSystemTime(1_000_500);
    // Only the hidden part of the span: the visible rest is still judged.
    expect(pausesDuring(1_000_050, 1_000_500).hiddenMs).toBe(50);
    expect(pausesDuring(1_000_200, 1_000_500).hiddenMs).toBe(0);
  });

  it("a Page Lifecycle freeze counts until resume", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    document.dispatchEvent(new Event("freeze"));
    vi.setSystemTime(2_000_100);
    document.dispatchEvent(new Event("resume"));
    vi.setSystemTime(2_000_500);
    expect(pausesDuring(2_000_000, 2_000_500).hiddenMs).toBe(100);
    expect(pausesDuring(2_000_200, 2_000_500).hiddenMs).toBe(0);
  });

  it("no stall API in jsdom: stalls are 0", () => {
    const now = Date.now();
    expect(pausesDuring(now - 10_000, now).stalledMs).toBe(0);
  });
});
