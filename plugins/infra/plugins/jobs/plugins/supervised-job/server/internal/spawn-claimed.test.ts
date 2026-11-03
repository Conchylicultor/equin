/**
 * The compensating close: a claimed run whose spawn fails must not keep holding
 * its kind's in-flight lock.
 *
 * The row is claimed with `process.pid` — this backend's own, alive — so if the
 * spawn throws, the reconciler's close rule reads the row as *running* on every
 * pass until the backend restarts, and the kind's partial unique index refuses
 * every future run in the meantime. Release carried this compensation by hand as
 * `failUnstartedRelease`; it lives here so build and deploy get it too.
 */
import { describe, expect, test } from "bun:test";
import { HARD_KILL_EXIT_CODE, type RunTerminal } from "../../core";
import { SupervisedSpawnError } from "./run/supervisor";
import { spawnClaimedRun } from "./spawn-claimed";

describe("spawnClaimedRun", () => {
  test("a successful spawn touches the row not at all", async () => {
    const closed: string[] = [];

    const started = await spawnClaimedRun(
      {
        start: () => Promise.resolve({ pid: 4242 }),
        closeRow: (runId) => {
          closed.push(runId);
          return Promise.resolve();
        },
      },
      "run-ok",
    );

    expect(started).toEqual({ pid: 4242 });
    expect(closed).toEqual([]);
  });

  test("a PRE-spawn failure closes the row and rethrows the ORIGINAL error", async () => {
    const closed: { runId: string; terminal: RunTerminal }[] = [];
    const preSpawn = new SupervisedSpawnError(
      "run failed to start BEFORE its child was spawned: ENOENT",
      false,
    );

    // The job still fails loudly — this is the wrapper's OWN failure, so it
    // earns the retry budget and the crash report.
    expect(
      spawnClaimedRun(
        {
          start: () => Promise.reject(preSpawn),
          closeRow: (runId, terminal) => {
            closed.push({ runId, terminal });
            return Promise.resolve();
          },
        },
        "run-enoent",
      ),
    ).rejects.toBe(preSpawn);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.runId).toBe("run-enoent");
    // The same sentinel the reconciler would stamp after a restart: no marker
    // was ever written, and none ever will be. No signal is claimed.
    expect(closed[0]?.terminal.exitCode).toBe(HARD_KILL_EXIT_CODE);
    expect(closed[0]?.terminal.signalCode).toBeNull();
  });

  test("a POST-spawn failure leaves the row in-flight for the reconciler", async () => {
    // `Bun.spawn` returned and the child is running; only the bookkeeping after
    // it failed. Closing the row here would release the kind's in-flight lock
    // under a live child, so the next enqueue would spawn a SECOND one — two
    // builds against one checkout. The child will write its own exit marker and
    // the reconciler settles it through the ordinary path.
    const closed: string[] = [];
    const postSpawn = new SupervisedSpawnError(
      "run failed to start AFTER its child was spawned: setPid write failed",
      true,
    );

    expect(
      spawnClaimedRun(
        {
          start: () => Promise.reject(postSpawn),
          closeRow: (runId) => {
            closed.push(runId);
            return Promise.resolve();
          },
        },
        "run-after-spawn",
      ),
    ).rejects.toBe(postSpawn);
    expect(closed).toEqual([]);
  });

  test("an unrecognised failure is treated as 'a child may be running'", async () => {
    // Compensation requires POSITIVE proof that no child exists. A wedged kind
    // is recoverable by a restart; a duplicated build is not, so the unknown
    // case takes the recoverable side.
    const closed: string[] = [];

    expect(
      spawnClaimedRun(
        {
          start: () => Promise.reject(new Error("something else entirely")),
          closeRow: (runId) => {
            closed.push(runId);
            return Promise.resolve();
          },
        },
        "run-unknown",
      ),
    ).rejects.toMatchObject({ message: "something else entirely" });

    expect(closed).toEqual([]);
  });

  test("a spawn failure whose close also fails reports BOTH", async () => {
    // The kind really is wedged until a restart in this case, so the message is
    // the only warning anyone gets — neither error may be swallowed by the other.
    const failed = spawnClaimedRun(
      {
        start: () => Promise.reject(new SupervisedSpawnError("EAGAIN", false)),
        closeRow: () => Promise.reject(new Error("db is down")),
      },
      "run-both",
    );

    expect(failed).rejects.toBeInstanceOf(AggregateError);
    expect(failed).rejects.toThrow("run-both");
    expect(failed).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "EAGAIN" }),
        expect.objectContaining({ message: "db is down" }),
      ],
    });
  });
});
