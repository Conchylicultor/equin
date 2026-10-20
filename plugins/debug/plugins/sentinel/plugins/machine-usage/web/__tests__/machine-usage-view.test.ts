/**
 * The "Where it goes" view model: each bucket as a share of the whole machine
 * (every core, all memory), totals that add the buckets up, and GB spelling.
 */

import { describe, expect, it } from "vitest";
import type { MachineUsage } from "../../core";
import { machineUsageView } from "../internal/machine-usage-view";

const GB = 1024 ** 3;

const usage: MachineUsage = {
  kind: "sampled",
  at: "2026-10-20T19:17:00.000Z",
  cores: 10,
  totalMemBytes: 32 * GB,
  groups: [
    { bucket: "chrome", processes: 40, cpuPercent: 180, memBytes: 7.4 * GB },
    { bucket: "agent-ops", processes: 12, cpuPercent: 280, memBytes: 6.2 * GB },
    {
      bucket: "agent-browser",
      processes: 6,
      cpuPercent: 60,
      memBytes: 2.8 * GB,
    },
    { bucket: "other", processes: 500, cpuPercent: 90, memBytes: 4.6 * GB },
  ],
};

describe("machineUsageView", () => {
  it("states each bucket as a share of the whole machine", () => {
    const view = machineUsageView(usage);
    expect(view.buckets.map((b) => [b.label, b.cpuText, b.memText])).toEqual([
      ["Your Chrome", "18%", "7.4 GB"],
      ["Agent ops", "28%", "6.2 GB"],
      ["Agent browser", "6%", "2.8 GB"],
      ["Other", "9%", "4.6 GB"],
    ]);
    expect(view.buckets[0]!.cpuShare).toBeCloseTo(0.18);
    expect(view.buckets[0]!.memShare).toBeCloseTo(7.4 / 32);
  });

  it("totals the buckets", () => {
    const view = machineUsageView(usage);
    expect(view.cpuTotalText).toBe("61%");
    expect(view.memTotalText).toBe("21 GB");
    expect(view.memOfText).toBe("of 32 GB");
  });

  it("caps a share at the whole machine", () => {
    const view = machineUsageView({
      ...usage,
      groups: [
        { bucket: "other", processes: 1, cpuPercent: 5_000, memBytes: 0 },
      ],
    });
    expect(view.buckets[0]!.cpuShare).toBe(1);
    expect(view.cpuTotalText).toBe("100%");
  });
});
