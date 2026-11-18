/**
 * The spawn primitives record every child a signal ended — unless our own
 * bound ended it — so a caller that only reads `exitCode !== 0` cannot turn an
 * OOM kill into a verdict: the check runner reads the watch for each check,
 * and `spawnExpectOk`'s error carries the kill as its cause.
 */
import { describe, expect, test } from "bun:test";
import {
  killedByOf,
  SpawnFailedError,
  spawnCaptured,
  spawnExpectOk,
  spawnPassthrough,
  watchChildKills,
} from "./index";

const BOUND = { timeoutMs: 10_000 } as const;
// A child the kernel ends the way the OOM killer does.
const SELF_KILL = ["sh", "-c", "kill -9 $$"];

describe("watchChildKills", () => {
  test("a child a signal ended is seen; one that exited is not", async () => {
    const watch = watchChildKills();
    await watch.run(async () => {
      await spawnCaptured(["sh", "-c", "exit 3"], BOUND);
      const killed = await spawnCaptured(SELF_KILL, BOUND);
      expect(killed.signalCode).toBe("SIGKILL");
    });
    expect(watch.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
    expect(watch.kills[0]!.message).toContain(
      "`sh -c kill -9 $$` was killed by SIGKILL",
    );
  });

  test("a child our own deadline ended is a timeout, not a kill", async () => {
    const watch = watchChildKills();
    const r = await watch.run(() =>
      spawnCaptured(["sleep", "30"], { timeoutMs: 50 }),
    );
    expect(r.timedOut).toBe(true);
    expect(watch.kills).toEqual([]);
  });

  test("a passthrough child is seen too", async () => {
    const watch = watchChildKills();
    await watch.run(() => spawnPassthrough(SELF_KILL));
    expect(watch.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
  });

  test("an enclosing watch sees what a nested one does; nothing outside one is kept", async () => {
    await spawnCaptured(SELF_KILL, BOUND);
    const outer = watchChildKills();
    const inner = watchChildKills();
    await outer.run(() => inner.run(() => spawnCaptured(SELF_KILL, BOUND)));
    expect(inner.kills).toHaveLength(1);
    expect(outer.kills).toHaveLength(1);
  });

  test("concurrent watches see only their own children", async () => {
    const a = watchChildKills();
    const b = watchChildKills();
    await Promise.all([
      a.run(() => spawnCaptured(SELF_KILL, BOUND)),
      b.run(() => spawnCaptured(["true"], BOUND)),
    ]);
    expect(a.kills).toHaveLength(1);
    expect(b.kills).toEqual([]);
  });
});

describe("spawnExpectOk's failure", () => {
  test("a killed child's SpawnFailedError carries the kill", async () => {
    const err = await spawnExpectOk(SELF_KILL, BOUND).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnFailedError);
    expect(killedByOf(err)?.signal).toBe("SIGKILL");
  });

  test("an exit code, or our own deadline, is no kill", async () => {
    const exited = await spawnExpectOk(["sh", "-c", "exit 3"], BOUND).catch(
      (e: unknown) => e,
    );
    expect(exited).toBeInstanceOf(SpawnFailedError);
    expect(killedByOf(exited)).toBeNull();
    const timedOut = await spawnExpectOk(["sleep", "30"], {
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(SpawnFailedError);
    expect((timedOut as SpawnFailedError).timedOut).toBe(true);
    expect(killedByOf(timedOut)).toBeNull();
  });
});
