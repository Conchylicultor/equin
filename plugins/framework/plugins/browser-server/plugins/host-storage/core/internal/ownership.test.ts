/**
 * What a storage's holder does with a claim, by the claimant's cause: a tab
 * of the same host joins it, never takes it; another build takes it over
 * (`updated`); without SharedWorker the tabs cannot share it (`unshared`);
 * older code is refused.
 */

import { describe, expect, test } from "bun:test";
import { answerClaim, type OwnerIdentity } from "./ownership";

const shared = (build: string, worker: string): OwnerIdentity => ({
  build,
  worker,
});
const dedicated = (build: string): OwnerIdentity => ({ build, worker: null });

const holder = {
  migrations: ["m1", "m2"],
  snapshotTakenAt: 100,
  identity: shared("b1", "demo@3"),
};

describe("answerClaim", () => {
  test("the same build, another worker name: join the holder's worker", () => {
    expect(
      answerClaim(holder, {
        migrations: ["m1", "m2"],
        snapshotTakenAt: 100,
        identity: shared("b1", "demo@4"),
      }),
    ).toEqual({ kind: "join", worker: "demo@3" });
  });

  test("another build at the same or newer code: it takes over, the holder's tabs told `updated`", () => {
    for (const claim of [
      { migrations: ["m1", "m2"], snapshotTakenAt: 100 },
      { migrations: ["m1", "m2", "m3"], snapshotTakenAt: 200 },
    ]) {
      expect(
        answerClaim(holder, { ...claim, identity: shared("b2", "demo@3") }),
      ).toEqual({ kind: "yield", why: "updated" });
    }
  });

  test("older code is refused, whatever its build", () => {
    for (const claim of [
      { migrations: ["m1"], snapshotTakenAt: 100 },
      { migrations: ["m1", "m2"], snapshotTakenAt: 50 },
    ]) {
      expect(
        answerClaim(holder, { ...claim, identity: shared("b0", "demo@4") }),
      ).toEqual({ kind: "refuse" });
    }
  });

  test("dedicated workers of the same build cannot be joined: `unshared`", () => {
    expect(
      answerClaim(
        { ...holder, identity: dedicated("b1") },
        {
          migrations: ["m1", "m2"],
          snapshotTakenAt: 100,
          identity: dedicated("b1"),
        },
      ),
    ).toEqual({ kind: "yield", why: "unshared" });
  });
});
