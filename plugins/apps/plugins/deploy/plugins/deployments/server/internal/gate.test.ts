import { describe, expect, test } from "bun:test";
import {
  checkDeployGates,
  type DeployGate,
  type DeployGateVerdict,
} from "./gate";

/** Await `p` and return what it rejected with; throw if it resolved. (`expect(p).rejects` is typed `void` under bun:test.) */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const subject = { deploymentId: "dpl-1", compositionId: "website" };
const gate = (id: string, message: string | null): DeployGate => ({
  id,
  check: (): Promise<DeployGateVerdict> =>
    Promise.resolve(
      message === null
        ? { kind: "pass" }
        : { kind: "needs-approval", message, resolveIn: `${id}-section` },
    ),
});

describe("checkDeployGates", () => {
  test("no gates, or every gate passing, passes", async () => {
    expect(await checkDeployGates(subject, [])).toEqual({ kind: "pass" });
    expect(await checkDeployGates(subject, [gate("a", null)])).toEqual({
      kind: "pass",
    });
  });

  test("every refusal is reported at once", async () => {
    expect(
      await checkDeployGates(subject, [
        gate("a", "approve A"),
        gate("b", null),
        gate("c", "approve C"),
      ]),
    ).toEqual({
      kind: "needs-approval",
      message: "approve A\n\napprove C",
      resolveIn: ["a-section", "c-section"],
    });
  });

  test("a gate that cannot decide fails the check rather than passing", async () => {
    const broken: DeployGate = {
      id: "broken",
      check: () => Promise.reject(new Error("store offline")),
    };
    expect(
      String(await rejection(checkDeployGates(subject, [broken]))),
    ).toContain("store offline");
  });
});
