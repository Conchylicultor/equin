import { describe, expect, test } from "bun:test";
import { SUPERVISED_EXIT_TEMPFAIL } from "../../core";
import {
  holdSlot,
  parseAdmissionPool,
  supervisedChildExitCode,
} from "./child-admission";

describe("parseAdmissionPool", () => {
  test("a declared pool is accepted", () => {
    expect(parseAdmissionPool("worktree-prepare")).toBe("worktree-prepare");
  });

  test("an undeclared pool is refused loudly, naming the declared ones", () => {
    expect(() => parseAdmissionPool("nope")).toThrow(/names no host pool/);
    expect(() => parseAdmissionPool("nope")).toThrow(/worktree-prepare/);
    // Not an own key of the table, however it is spelled.
    expect(() => parseAdmissionPool("toString")).toThrow(/names no host pool/);
  });
});

describe("supervisedChildExitCode", () => {
  test("a database full at boot exits EX_TEMPFAIL, even wrapped", () => {
    const refused = Object.assign(
      new Error("no more connections allowed (max_client_conn)"),
      { code: "08P01" },
    );
    expect(supervisedChildExitCode(refused)).toBe(SUPERVISED_EXIT_TEMPFAIL);
    expect(
      supervisedChildExitCode(
        new Error("Database did not become reachable within 30000ms", {
          cause: refused,
        }),
      ),
    ).toBe(SUPERVISED_EXIT_TEMPFAIL);
  });

  test("every other failure exits 1", () => {
    expect(supervisedChildExitCode(new Error("install failed"))).toBe(1);
    expect(
      supervisedChildExitCode(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(1);
  });
});

describe("holdSlot", () => {
  /** A one-slot pool with `run`'s contract: the slot is held while `fn` runs. */
  function onePool() {
    let busy = false;
    const queue: (() => void)[] = [];
    const pool = {
      async run(
        fn: () => Promise<void>,
        hooks: { onAcquired: (waitMs: number) => void },
      ): Promise<void> {
        if (busy) await new Promise<void>((r) => queue.push(r));
        busy = true;
        hooks.onAcquired(0);
        try {
          await fn();
        } finally {
          busy = false;
          queue.shift()?.();
        }
      },
    };
    return { pool, busy: () => busy };
  }

  test("holds the slot past the call, and frees it on release — so a waiter holds no slot", async () => {
    const { pool, busy } = onePool();
    const held = await holdSlot(pool, () => {});
    expect(busy()).toBe(true);
    // Another child queues behind it…
    let otherAdmitted = false;
    const other = holdSlot(pool, () => {}).then((slot) => {
      otherAdmitted = true;
      return slot;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(otherAdmitted).toBe(false);
    // …and is admitted the moment this one gives its slot back to wait.
    await held.release();
    const otherSlot = await other;
    expect(otherAdmitted).toBe(true);
    await otherSlot.release();
    expect(busy()).toBe(false);
  });
});
