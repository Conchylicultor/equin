import { describe, expect, it } from "bun:test";
import {
  BUILD_EXIT_HARD_KILLED,
  BUILD_EXIT_SUPERSEDED,
} from "@plugins/build/plugins/build-status/core";
import { buildRunIdKind } from "@plugins/build/plugins/run-ledger/core";
import type { BuildRun } from "../../shared";
import { latestRunState } from "./latest-run-state";

function run(over: Partial<BuildRun>): BuildRun {
  return {
    id: buildRunIdKind.key("b1"),
    trigger: "auto",
    commitHash: null,
    targets: ["singularity"],
    startedAt: new Date(0),
    finishedAt: new Date(1),
    exitCode: 0,
    ...over,
  };
}

describe("latestRunState", () => {
  it("no run: nothing to say", () => {
    expect(latestRunState(undefined)).toBeNull();
  });
  it("no finishedAt: running", () => {
    expect(latestRunState(run({ finishedAt: null, exitCode: null }))).toBe(
      "running",
    );
  });
  it("a bad verdict: failed", () => {
    expect(latestRunState(run({ exitCode: 1 }))).toBe("failed");
  });
  it("success, superseded, interrupted, killed: not failed", () => {
    for (const exitCode of [
      0,
      BUILD_EXIT_SUPERSEDED,
      BUILD_EXIT_HARD_KILLED,
      143,
    ]) {
      expect(latestRunState(run({ exitCode }))).toBeNull();
    }
  });
});
