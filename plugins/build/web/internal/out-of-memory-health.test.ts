import { describe, expect, it } from "bun:test";
import {
  BUILD_EXIT_OUT_OF_MEMORY,
  BUILD_EXIT_SUPERSEDED,
} from "@plugins/build/plugins/build-status/core";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import type { BuildRun } from "../../core";
import { outOfMemoryHealth } from "./out-of-memory-health";

let n = 0;
function run(over: Partial<BuildRun>): BuildRun {
  n++;
  return {
    id: buildRunIdKind.key(`b${n}`),
    trigger: "auto",
    commitHash: null,
    targets: [MAIN_COMPOSITION_ID],
    startedAt: new Date(0),
    finishedAt: new Date(1),
    exitCode: 0,
    ...over,
  };
}

const oom = run({
  exitCode: BUILD_EXIT_OUT_OF_MEMORY,
  commitHash: "bbbbbbbbbbbbbbbb",
});
const served = run({ exitCode: 0, commitHash: "aaaaaaaaaaaaaaaa" });

describe("outOfMemoryHealth", () => {
  it("no history: nothing to say", () => {
    expect(outOfMemoryHealth([])).toEqual({ state: "absent" });
  });

  it("newest closed run out of memory: attention, naming the commit still running", () => {
    const status = outOfMemoryHealth([oom, served]);
    expect(status.state).toBe("attention");
    if (status.state !== "attention") throw new Error("unreachable");
    expect(status.title).toBe("Update not deployed");
    expect(status.transitioning).toBe(false);
    expect(status.summary).toContain("ran out of memory");
    expect(status.summary).toContain("bbbbbbbbb");
    expect(status.summary).toContain("still running aaaaaaaaa");
    expect(status.summary).toContain("Closing other apps frees memory");
  });

  it("a retry in flight above it: still attention, pulsing", () => {
    const status = outOfMemoryHealth([
      run({ finishedAt: null, exitCode: null }),
      oom,
      served,
    ]);
    expect(status.state).toBe("attention");
    if (status.state !== "attention") throw new Error("unreachable");
    expect(status.transitioning).toBe(true);
    expect(status.summary).toContain("A build is running now");
  });

  it("no earlier success in the window: says so without naming a commit", () => {
    const status = outOfMemoryHealth([oom]);
    expect(status.summary).toContain("still running the version from before");
  });

  it("a later run closed with any other end: absent", () => {
    expect(outOfMemoryHealth([served, oom])).toEqual({ state: "absent" });
    expect(outOfMemoryHealth([run({ exitCode: 1 }), oom])).toEqual({
      state: "absent",
    });
    expect(
      outOfMemoryHealth([run({ exitCode: BUILD_EXIT_SUPERSEDED }), oom]),
    ).toEqual({ state: "absent" });
  });

  it("a killed run is not out of memory: absent", () => {
    expect(outOfMemoryHealth([run({ exitCode: 137 })])).toEqual({
      state: "absent",
    });
  });
});
