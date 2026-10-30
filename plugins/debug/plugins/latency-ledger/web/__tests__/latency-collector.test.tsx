// The collector feeds the ledger's `update-e2e` metric from the `update`
// latency signal's total — one subscriber on clientLatencySink among several.
// A sample the tab spent hidden in is kept but excluded; other signals are not recorded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { clientLatencySink } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { recordSample } from "../internal/client-ledger";
import { LatencyCollector } from "../components/latency-collector";

vi.mock("../internal/client-ledger", () => ({
  recordSample: vi.fn(),
  recordInteraction: vi.fn(),
}));
vi.mock("../internal/interaction-tracker", () => ({
  startInteractionTracking: () => () => {},
}));
let pageHidden = false;
vi.mock("@plugins/primitives/plugins/perfs/plugins/page-pauses/web", () => ({
  pausesDuring: () => ({ hidden: pageHidden, stalledMs: 0 }),
}));

const recordMock = vi.mocked(recordSample);

const update = () =>
  ({
    signal: "update",
    key: "tasks",
    params: {},
    phases: {
      "server-notice": 10,
      "throttle-hold": 0,
      "server-deliver": 20,
      transport: 5,
      "client-apply": 3,
    },
    totalMs: 38,
  }) as const;

afterEach(() => {
  pageHidden = false;
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
        "server-ack": 40,
        "confirm-frame": 10,
      },
      totalMs: 50,
    });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<LatencyCollector />);
    unmount();
    expect(clientLatencySink.hasSubscribers()).toBe(false);
    clientLatencySink.emit(update());
    expect(recordMock).not.toHaveBeenCalled();
  });
});
