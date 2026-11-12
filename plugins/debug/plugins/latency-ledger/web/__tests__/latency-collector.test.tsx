// The collector feeds the ledger's `update-e2e` metric from the `update`
// latency signal's total — one subscriber on clientLatencySink among several.
// A sample the tab spent hidden in is kept but excluded; other signals are not recorded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { flushOnPageHide, recordSample } from "../internal/client-ledger";
import { cutActiveInteraction } from "../internal/interaction-tracker";
import { LatencyCollector } from "../components/latency-collector";

const order: string[] = [];
vi.mock("../internal/client-ledger", () => ({
  recordSample: vi.fn(),
  recordInteraction: vi.fn(),
  flushOnPageHide: vi.fn(() => order.push("flush")),
}));
vi.mock("../internal/interaction-tracker", () => ({
  startInteractionTracking: () => () => {},
  cutActiveInteraction: vi.fn(() => order.push("cut")),
}));
let pageHidden = false;
vi.mock(
  "@plugins/primitives/plugins/perfs/plugins/page-pauses/web",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    pausesDuring: () => ({ hiddenMs: pageHidden ? 1 : 0, stalledMs: 0 }),
  }),
);

const recordMock = vi.mocked(recordSample);

const update = () =>
  ({
    signal: "update",
    key: "tasks",
    params: {},
    phases: {
      "watch-delivery": 0,
      "server-notice": 10,
      "throttle-hold": 0,
      "server-deliver": 20,
      transport: 5,
      "page-wait": 0,
      "client-apply": 3,
    },
    totalMs: 38,
  }) as const;

afterEach(() => {
  pageHidden = false;
  order.length = 0;
  vi.mocked(flushOnPageHide).mockClear();
  vi.mocked(cutActiveInteraction).mockClear();
  cleanup();
  recordMock.mockClear();
});

describe("LatencyCollector", () => {
  it("records an update sample's total as update-e2e", () => {
    render(<LatencyCollector />);
    clientLatencySink.emit(update());
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith("update-e2e", 38, {
      excluded: false,
    });
  });

  it("excludes a hidden tab's sample", () => {
    render(<LatencyCollector />);
    pageHidden = true;
    clientLatencySink.emit(update());
    expect(recordMock).toHaveBeenCalledWith("update-e2e", 38, {
      excluded: true,
    });
  });

  it("ignores other signals", () => {
    render(<LatencyCollector />);
    clientLatencySink.emit({
      signal: "confirm",
      key: "page.blocks",
      params: {},
      variant: "exact-ack/push",
      phases: {
        "send-lane": 0,
        retry: 0,
        "request-queue": 0,
        network: 0,
        server: 0,
        "page-resume": 0,
        "ack-unsplit": 40,
        "confirm-frame": 10,
      },
      totalMs: 50,
    });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("on pagehide, cuts the load in flight short BEFORE the final flush", () => {
    // A tab reloading faster than its page settles leaves a row per load only
    // if the unsettled load is recorded before the batch goes out.
    render(<LatencyCollector />);
    window.dispatchEvent(new Event("pagehide"));
    expect(order).toEqual(["cut", "flush"]);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<LatencyCollector />);
    unmount();
    expect(clientLatencySink.hasSubscribers()).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(order).toEqual([]);
    clientLatencySink.emit(update());
    expect(recordMock).not.toHaveBeenCalled();
  });
});
