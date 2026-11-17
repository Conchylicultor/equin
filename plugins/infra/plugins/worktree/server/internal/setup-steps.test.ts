import { describe, expect, test } from "bun:test";
import {
  describeSetupStep,
  recordSetupSteps,
  type SetupStep,
  timeStep,
} from "./setup-steps";

describe("setup steps", () => {
  test("a step reports its duration when it ends, and passes its value through", async () => {
    const seen: SetupStep[] = [];
    const out = await timeStep(
      (s) => seen.push(s),
      "install",
      async () => "done",
    );
    expect(out).toBe("done");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.step).toBe("install");
    expect(seen[0]?.failed).toBeUndefined();
    expect(seen[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  test("a step that throws is reported as failed, and the error still reaches the caller", async () => {
    const seen: SetupStep[] = [];
    expect(
      timeStep(
        (s) => seen.push(s),
        "tree-write",
        async () => {
          throw new Error("git reset exited 128");
        },
      ),
    ).rejects.toThrow("git reset exited 128");
    expect(seen).toEqual([
      { step: "tree-write", ms: expect.any(Number), failed: true },
    ]);
  });

  test("the record forwards each step as it ends and sums them up in order", () => {
    const forwarded: string[] = [];
    const steps = recordSetupSteps((s) => forwarded.push(describeSetupStep(s)));
    steps.onStep({ step: "gate-wait", ms: 40 });
    steps.onStep({ step: "install", ms: 12_345, failed: true });
    expect(forwarded).toEqual([
      "gate-wait 40 ms",
      "install FAILED after 12.3 s",
    ]);
    expect(steps.summary()).toMatch(
      /^total \d+ ms, gate-wait 40 ms, install FAILED after 12\.3 s$/,
    );
  });
});
