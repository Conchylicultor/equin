/**
 * The Machine watcher health row's verdict: never green before it is read, loud
 * when main's watcher is down or its process is gone, pulsing while it restarts.
 */

import { describe, expect, it } from "vitest";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type {
  SentinelStatus,
  SentinelWatch,
} from "@plugins/debug/plugins/sentinel/plugins/status-file/core";
import type { SentinelStatusValue } from "../../core";
import { machineWatcherVerdict } from "../internal/machine-watcher-health";

const refetch = () => Promise.resolve();

function settled(
  watch: SentinelWatch,
  duress: SentinelStatusValue["duress"] = null,
  disk: SentinelStatusValue["disk"] = "ok",
): ResourceResult<SentinelStatusValue> {
  return { status: "ready", data: { watch, duress, disk }, refetch };
}

function recorded(
  status: SentinelStatus,
  ownerAlive = true,
  duress: SentinelStatusValue["duress"] = null,
  disk: SentinelStatusValue["disk"] = "ok",
): ResourceResult<SentinelStatusValue> {
  return settled(
    { kind: "recorded", status, pid: 42, ownerAlive },
    duress,
    disk,
  );
}

describe("Machine watcher health row", () => {
  it("is unknown — not ok — while loading", () => {
    expect(
      machineWatcherVerdict({
        status: "loading",
        refetch,
      }),
    ).toEqual({ state: "unknown" });
  });

  it("is unknown with a reason when nothing was recorded or the file is unreadable", () => {
    expect(machineWatcherVerdict(settled({ kind: "none" })).state).toBe(
      "unknown",
    );
    const unreadable = machineWatcherVerdict(
      settled({ kind: "unreadable", reason: "not JSON" }),
    );
    expect(unreadable).toEqual({
      state: "unknown",
      summary: "The machine watcher's status file is unreadable: not JSON",
    });
  });

  it("is ok while running", () => {
    expect(
      machineWatcherVerdict(recorded({ state: "running", since: Date.now() }))
        .state,
    ).toBe("ok");
  });

  it("asks for attention while running under duress, saying since when", () => {
    const since = new Date(2026, 8, 17, 18, 2).getTime();
    const verdict = machineWatcherVerdict(
      recorded({ state: "running", since: since - 60_000 }, true, { since }),
    );
    expect(verdict.state).toBe("attention");
    expect("transitioning" in verdict && verdict.transitioning).toBeFalsy();
    expect("summary" in verdict && verdict.summary).toMatch(
      /^Under duress since .*02.* · builds held back$/,
    );
  });

  it("asks for attention while the disk is low or filling fast, after duress", () => {
    const running = { state: "running", since: Date.now() } as const;
    expect(machineWatcherVerdict(recorded(running, true, null, "low"))).toEqual(
      {
        state: "attention",
        summary: "Disk space is running low",
      },
    );
    expect(
      machineWatcherVerdict(recorded(running, true, null, "filling")).state,
    ).toBe("attention");
    const both = machineWatcherVerdict(
      recorded(running, true, { since: Date.now() }, "filling"),
    );
    expect("summary" in both && both.summary).toMatch(/^Under duress/);
    expect(
      machineWatcherVerdict(recorded(running, true, null, null)).state,
    ).toBe("ok");
  });

  it("is critical when the disk is full or will be within the hour, over duress", () => {
    const running = { state: "running", since: Date.now() } as const;
    expect(
      machineWatcherVerdict(
        recorded(running, true, { since: Date.now() }, "full-soon"),
      ),
    ).toEqual({
      state: "critical",
      summary: "The disk will be full within the hour at this rate",
    });
    expect(
      machineWatcherVerdict(recorded(running, true, null, "full")).state,
    ).toBe("critical");
  });

  it("does not claim duress when the watcher is not running", () => {
    const verdict = machineWatcherVerdict(
      recorded({ state: "stopped", since: Date.now() }, true, {
        since: Date.now(),
      }),
    );
    expect(verdict.state).toBe("attention");
  });

  it("is critical when down, carrying the last error", () => {
    const verdict = machineWatcherVerdict(
      recorded({
        state: "down",
        since: Date.now(),
        deaths: 5,
        lastError: "runtimeNamespace() not declared",
      }),
    );
    expect(verdict.state).toBe("critical");
    expect("summary" in verdict && verdict.summary).toContain(
      "builds are not held back",
    );
    expect("summary" in verdict && verdict.summary).toContain(
      "runtimeNamespace() not declared",
    );
  });

  it("is critical when the process that wrote 'running' is gone", () => {
    expect(
      machineWatcherVerdict(
        recorded({ state: "running", since: Date.now() }, false),
      ),
    ).toEqual({
      state: "critical",
      summary:
        "Main is not running its machine watcher — builds are not held back when memory runs out",
    });
  });

  it("pulses attention while restarting", () => {
    expect(
      machineWatcherVerdict(
        recorded({
          state: "respawning",
          since: Date.now(),
          deaths: 2,
          lastError: null,
        }),
      ),
    ).toEqual({
      state: "attention",
      summary: "Restarting after 2 crashes",
      transitioning: true,
    });
  });

  it("is attention when turned off, even with main gone", () => {
    expect(
      machineWatcherVerdict(
        recorded({ state: "disabled", since: Date.now() }, false),
      ).state,
    ).toBe("attention");
  });
});
