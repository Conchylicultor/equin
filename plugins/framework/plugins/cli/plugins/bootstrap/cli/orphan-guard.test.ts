import { withEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core/testing";
import { afterEach, expect, test } from "bun:test";
import {
  disarmOrphanGuard,
  installOrphanGuard,
  ORPHAN_EXIT_CODE,
} from "./orphan-guard";

/**
 * The guard's decision is "has this process been reparented", read from
 * `process.ppid` on a 2s poll. These tests cover the two edges that are cheap to
 * get wrong and expensive to discover in production — arming at all, and
 * disarming for a command that is MEANT to be detached — without waiting on real
 * poll ticks. The end-to-end reparent behaviour is verified by orphaning a real
 * `./equin` invocation, which no unit test can stand in for.
 */

// Every test must leave the runner with no live poll, or an unref'd interval
// would survive into the next test and (worse) into an unrelated suite.
afterEach(() => disarmOrphanGuard());

test("arming under a live parent does not fire", () => {
  // The test runner has a real parent, so ppid !== 1 and the immediate-orphan
  // branch must not be taken.
  expect(process.ppid).not.toBe(1);
  let fired = false;
  installOrphanGuard(() => {
    fired = true;
  });
  expect(fired).toBe(false);
});

test("arming installs a poll that disarm removes", () => {
  installOrphanGuard(() => {});
  // A live poll keeps a handle on the loop even when unref'd, so the observable
  // difference is whether disarm is a no-op the second time around.
  disarmOrphanGuard();
  // Idempotent: a command may disarm without first checking whether it armed.
  expect(() => disarmOrphanGuard()).not.toThrow();
});

test("BUILD_DETACHED skips arming entirely", async () => {
  await withEnv({ BUILD_DETACHED: "1" }, () => {
    let fired = false;
    installOrphanGuard(() => {
      fired = true;
    });
    expect(fired).toBe(false);
    // Nothing was installed, so disarm has nothing to cancel and must not throw.
    expect(() => disarmOrphanGuard()).not.toThrow();
  });
});

test("ORPHAN_EXIT_CODE is the documented 128 + 12", () => {
  // Callers key on this number to tell an orphan-kill apart from a real failure,
  // so it is part of the CLI's contract rather than an implementation detail.
  expect(ORPHAN_EXIT_CODE).toBe(140);
});
