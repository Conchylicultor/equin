import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitThroughGate,
  checkValveGuard,
  createGateLocks,
  EXCLUSIVE_RUNNING_REASON,
  mustRequeue,
  valveGates,
  type GateHold,
  type GateLocks,
  type GateMode,
  type HoldResult,
  type ValveDeps,
} from "./admission-valve";

// The admission loop runs on injected seams: an in-memory readers/writer gate
// and a latch the test flips. The real flocks are covered at the end, on a
// throwaway directory — never the host's own gate, which live builds use.

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** An in-memory readers/writer lock with the GateLocks contract. */
function fakeGate() {
  let shared = 0;
  let exclusive = false;
  const pending: {
    mode: GateMode;
    resolve: (hold: GateHold) => void;
  }[] = [];
  const fits = (mode: GateMode): boolean =>
    mode === "shared" ? !exclusive : !exclusive && shared === 0;
  const take = (mode: GateMode): GateHold => {
    if (mode === "shared") shared++;
    else exclusive = true;
    let released = false;
    return {
      mode,
      release: () => {
        if (!released) {
          released = true;
          if (mode === "shared") shared--;
          else exclusive = false;
          for (const p of [...pending]) {
            if (!fits(p.mode)) continue;
            pending.splice(pending.indexOf(p), 1);
            p.resolve(take(p.mode));
          }
        }
        return Promise.resolve();
      },
    };
  };
  const locks: GateLocks = {
    tryLock: (mode) => (fits(mode) ? take(mode) : null),
    waitLock: (mode, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason as Error);
          return;
        }
        const p = { mode, resolve };
        pending.push(p);
        signal?.addEventListener(
          "abort",
          () => {
            const i = pending.indexOf(p);
            if (i < 0) return;
            pending.splice(i, 1);
            reject(signal.reason as Error);
          },
          { once: true },
        );
      }),
    joinLine: (signal) => {
      signal.throwIfAborted();
      return Promise.resolve({ leave: () => undefined });
    },
  };
  return { locks, take, state: () => ({ shared, exclusive }) };
}

function harness(opts: { duress?: boolean } = {}) {
  let duress = opts.duress ?? false;
  let duressChecks = 0;
  const wakers = new Set<() => void>();
  const gate = fakeGate();
  const holds: { start: (string | null)[]; end: HoldResult[] } = {
    start: [],
    end: [],
  };
  const deps: ValveDeps = {
    isUnderDuress: () => {
      duressChecks++;
      return duress;
    },
    duressGuard: () => ({ kind: "on" }),
    duressReason: () => "cluster-onset: decompressionsPerSec",
    waitForWake: (signal) =>
      new Promise((resolve) => {
        const done = (): void => {
          wakers.delete(done);
          resolve();
        };
        if (signal.aborted) {
          resolve();
          return;
        }
        wakers.add(done);
        signal.addEventListener("abort", done, { once: true });
      }),
    gate: gate.locks,
    onHoldStart: (reason) => holds.start.push(reason),
    onHoldEnd: (result) => holds.end.push(result),
  };
  return {
    deps,
    gate,
    holds,
    duressChecks: () => duressChecks,
    setDuress(next: boolean) {
      duress = next;
      for (const wake of [...wakers]) wake();
    },
  };
}

/** Tracks whether a pending admission has resolved yet. */
function track(p: Promise<GateHold | null>) {
  let hold: GateHold | null | undefined;
  void p.then((h) => {
    hold = h;
  });
  return { done: () => hold !== undefined, hold: () => hold, promise: p };
}

describe("valveGates", () => {
  test("only the background lane is gated", () => {
    expect(valveGates("background", {})).toBe(true);
    expect(valveGates("interactive", {})).toBe(false);
  });

  test("the detached main auto-build is not gated (v1 adopted decision)", () => {
    expect(valveGates("background", { SINGULARITY_BUILD_DETACHED: "1" })).toBe(
      false,
    );
  });
});

describe("checkValveGuard", () => {
  const off = () => ({
    kind: "off" as const,
    why: "the machine watcher is down",
  });

  test("a gated build with the guard off gets a verdict note", () => {
    expect(checkValveGuard({ gated: true }, { duressGuard: off })).toBe(
      "duress guard off: the machine watcher is down",
    );
  });

  test("the guard on: no note", () => {
    expect(
      checkValveGuard({ gated: true }, { duressGuard: () => ({ kind: "on" }) }),
    ).toBeNull();
  });

  test("an ungated build never reads the status file", () => {
    let reads = 0;
    const counting = () => {
      reads++;
      return off();
    };
    expect(
      checkValveGuard({ gated: false }, { duressGuard: counting }),
    ).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("admitThroughGate", () => {
  test("ungated: no gate, the latch is never consulted", async () => {
    const h = harness({ duress: true }); // would hold if consulted
    expect(await admitThroughGate({ gated: false }, h.deps)).toBeNull();
    expect(h.duressChecks()).toBe(0);
  });

  test("calm: admitted shared at once, beside other calm builds, no hold", async () => {
    const h = harness();
    const other = h.gate.take("shared");
    const hold = await admitThroughGate({ gated: true }, h.deps);
    expect(hold?.mode).toBe("shared");
    expect(h.holds).toEqual({ start: [], end: [] });
    await hold?.release();
    await other.release();
  });

  test("under duress, alone: admitted exclusive", async () => {
    const h = harness({ duress: true });
    const hold = await admitThroughGate({ gated: true }, h.deps);
    expect(hold?.mode).toBe("exclusive");
    expect(h.holds).toEqual({
      start: ["cluster-onset: decompressionsPerSec"],
      end: ["acquired"],
    });
    await hold?.release();
  });

  test("under duress, waits for the running build to finish — no timeout", async () => {
    const h = harness({ duress: true });
    const running = h.gate.take("shared");
    const admit = track(admitThroughGate({ gated: true }, h.deps));
    for (let i = 0; i < 20; i++) await tick();
    expect(admit.done()).toBe(false);

    await running.release();
    const hold = await admit.promise;
    expect(hold?.mode).toBe("exclusive");
    expect(h.holds.end).toEqual(["acquired"]);
    await hold?.release();
  });

  test("duress clears while waiting: admitted shared beside the running build", async () => {
    const h = harness({ duress: true });
    const running = h.gate.take("shared");
    const admit = track(admitThroughGate({ gated: true }, h.deps));
    await tick();
    expect(admit.done()).toBe(false);

    h.setDuress(false);
    const hold = await admit.promise;
    expect(hold?.mode).toBe("shared");
    expect(h.holds.end).toEqual(["cleared"]);
    await hold?.release();
    await running.release();
  });

  test("calm, but a build admitted under duress runs: wait for it, then go shared", async () => {
    const h = harness();
    const alone = h.gate.take("exclusive");
    const admit = track(admitThroughGate({ gated: true }, h.deps));
    await tick();
    expect(admit.done()).toBe(false);
    expect(h.holds.start).toEqual([EXCLUSIVE_RUNNING_REASON]);

    await alone.release();
    const hold = await admit.promise;
    expect(hold?.mode).toBe("shared");
    expect(h.holds.end).toEqual(["cleared"]);
    await hold?.release();
  });

  test("duress trips while waiting for the shared lock: runs alone instead", async () => {
    const h = harness();
    const alone = h.gate.take("exclusive");
    const admit = track(admitThroughGate({ gated: true }, h.deps));
    await tick();

    h.setDuress(true);
    await alone.release();
    const hold = await admit.promise;
    // Got the shared lock, saw duress, released it, came back exclusive.
    expect(hold?.mode).toBe("exclusive");
    expect(h.holds.start).toEqual([EXCLUSIVE_RUNNING_REASON]);
    expect(h.holds.end).toEqual(["acquired"]);
    expect(h.gate.state()).toEqual({ shared: 0, exclusive: true });
    await hold?.release();
  });
});

// The post-grant re-check: a build holds its CPU grant, then asks whether duress
// tripped while it was queued for it.
describe("mustRequeue", () => {
  const shared: GateHold = { mode: "shared", release: () => Promise.resolve() };
  const exclusive: GateHold = {
    mode: "exclusive",
    release: () => Promise.resolve(),
  };

  test("admitted shared, duress tripped meanwhile ⇒ release and run alone", () => {
    expect(mustRequeue(shared, true)).toBe(true);
  });

  test("admitted shared, still calm ⇒ run", () => {
    expect(mustRequeue(shared, false)).toBe(false);
  });

  test("admitted alone ⇒ never requeued, so the loop terminates", () => {
    expect(mustRequeue(exclusive, true)).toBe(false);
  });

  test("ungated (main / detached) ⇒ never requeued", () => {
    expect(mustRequeue(null, true)).toBe(false);
  });
});

describe("createGateLocks (real flocks)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  const gateIn = (): GateLocks => {
    const dir = mkdtempSync(join(tmpdir(), "agent-build-gate-"));
    root = dir;
    return createGateLocks({
      file: (...segments) => join(dir, ...segments),
      ensure: () => {
        mkdirSync(dir, { recursive: true });
        return dir;
      },
    });
  };

  test("calm builds share; an exclusive one waits for them all", async () => {
    const gate = gateIn();
    const a = gate.tryLock("shared");
    const b = gate.tryLock("shared");
    expect(a?.mode).toBe("shared");
    expect(b?.mode).toBe("shared");
    expect(gate.tryLock("exclusive")).toBeNull();

    let granted = false;
    const alone = gate.waitLock("exclusive").then((h) => {
      granted = true;
      return h;
    });
    await a?.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(granted).toBe(false); // b still runs

    await b?.release();
    const hold = await alone;
    expect(hold.mode).toBe("exclusive");
    expect(gate.tryLock("shared")).toBeNull(); // it keeps everyone out
    await hold.release();
    await hold.release(); // idempotent
    const after = gate.tryLock("shared");
    expect(after).not.toBeNull();
    await after?.release();
  });

  test("an aborted exclusive wait throws its reason and takes nothing", async () => {
    const gate = gateIn();
    const running = gate.tryLock("shared");
    const ac = new AbortController();
    const waiting = gate.waitLock("exclusive", ac.signal);
    ac.abort(new Error("duress cleared"));
    let reason: unknown;
    try {
      await waiting;
    } catch (err) {
      reason = err;
    }
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe("duress cleared");
    const more = gate.tryLock("shared");
    expect(more).not.toBeNull();
    await more?.release();
    await running?.release();
  });
});
