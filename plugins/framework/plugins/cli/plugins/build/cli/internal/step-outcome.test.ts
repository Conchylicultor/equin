import { describe, expect, test } from "bun:test";
import { ChildKilledError } from "@plugins/infra/plugins/spawn/core";
import {
  checkStepOutcome,
  stepOutcomeOfError,
  stepsKilledBy,
  type StepOutcome,
} from "./step-outcome";

const step = (outcome: StepOutcome) => ({ outcome });
const ok = step({ kind: "ok" });
const failed = step({ kind: "failed" });
const killed = (signal: string) => step({ kind: "killed", signal });

describe("stepsKilledBy", () => {
  test("every failing step killed: the failure is no verdict, named by the first", () => {
    expect(stepsKilledBy([ok, killed("SIGKILL")])).toBe("SIGKILL");
    expect(stepsKilledBy([killed("SIGKILL"), ok, killed("SIGTERM")])).toBe(
      "SIGKILL",
    );
  });

  test("a real failure beside a kill is a verdict", () => {
    expect(stepsKilledBy([killed("SIGKILL"), failed])).toBeNull();
    expect(stepsKilledBy([failed, killed("SIGKILL")])).toBeNull();
  });

  test("all passing is no kill", () => {
    expect(stepsKilledBy([ok, ok])).toBeNull();
    expect(stepsKilledBy([])).toBeNull();
  });
});

describe("stepOutcomeOfError", () => {
  test("a ChildKilledError, even wrapped, is killed", () => {
    const err = new Error("pipeline failed", {
      cause: new ChildKilledError("type-check worker", "SIGKILL"),
    });
    expect(stepOutcomeOfError(err)).toEqual({
      kind: "killed",
      signal: "SIGKILL",
    });
  });

  test("anything else is failed", () => {
    expect(stepOutcomeOfError(new Error("compile error"))).toEqual({
      kind: "failed",
    });
  });
});

describe("checkStepOutcome", () => {
  test("maps a check pass's ending one to one", () => {
    expect(checkStepOutcome({ kind: "passed" })).toEqual({ kind: "ok" });
    expect(checkStepOutcome({ kind: "failed" })).toEqual({ kind: "failed" });
    expect(checkStepOutcome({ kind: "killed", signal: "SIGKILL" })).toEqual({
      kind: "killed",
      signal: "SIGKILL",
    });
  });
});
