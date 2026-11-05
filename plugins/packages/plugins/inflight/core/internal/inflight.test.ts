import { describe, expect, test } from "bun:test";
import { createInflight } from "./inflight";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createInflight", () => {
  test("shares one execution across concurrent callers with the same key", async () => {
    const inflight = createInflight();
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    const fn = async () => {
      calls++;
      await gate;
      return "result";
    };

    const a = inflight.run("k", fn);
    const b = inflight.run("k", fn);
    expect(inflight.size).toBe(1);
    open();
    expect(await Promise.all([a, b])).toEqual(["result", "result"]);
    expect(calls).toBe(1); // body ran once, both callers got it
  });

  test("distinct keys run independently", async () => {
    const inflight = createInflight();
    let calls = 0;
    const fn = async () => {
      calls++;
      return calls;
    };
    const [a, b] = await Promise.all([
      inflight.run("a", fn),
      inflight.run("b", fn),
    ]);
    expect(calls).toBe(2);
    expect(new Set([a, b])).toEqual(new Set([1, 2]));
  });

  test("clears the key after settlement — a later call runs fresh", async () => {
    const inflight = createInflight();
    let calls = 0;
    const fn = async () => ++calls;

    expect(await inflight.run("k", fn)).toBe(1);
    expect(inflight.size).toBe(0); // cleared on settle
    expect(await inflight.run("k", fn)).toBe(2); // not cached — runs again
  });

  test("shares a rejection then clears the key", async () => {
    const inflight = createInflight();
    let calls = 0;
    const fn = async () => {
      calls++;
      await tick();
      throw new Error("boom");
    };

    const messages = await Promise.all([
      inflight.run("k", fn).catch((err) => (err as Error).message),
      inflight.run("k", fn).catch((err) => (err as Error).message),
    ]);
    expect(messages).toEqual(["boom", "boom"]);
    expect(calls).toBe(1); // both shared the one failing body
    expect(inflight.size).toBe(0); // failure cleared the key

    // Next call retries fresh rather than inheriting the failed promise.
    expect(await inflight.run("k", async () => "fine")).toBe("fine");
  });
});

/**
 * The freshness floor (`opts.notBefore`) — the correctness-bearing half of this
 * primitive, added for the 2026-08-08 live-state stale-flight incident
 * (`research/2026-08-08-global-live-state-flight-freshness.md`). A caller that
 * already knows about something that happened at instant T may not be served by a
 * body that STARTED before T; such a flight is superseded, not joined.
 *
 * `startedAt` is a real `performance.now()` reading, so these tests derive their
 * floors from readings taken around the flight rather than from constants.
 */
describe("createInflight — freshness floor (notBefore)", () => {
  /** A body that parks until released, counting how many times it was entered. */
  function parked() {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      fn: async () => {
        const mine = ++calls;
        await gate;
        return mine;
      },
      release: open,
    };
  }

  test("a floor OLDER than the live flight joins it: the body runs once", async () => {
    const inflight = createInflight();
    const p = parked();
    const before = performance.now(); // earlier than the flight's startedAt
    const a = inflight.run("k", p.fn);
    await tick();
    const b = inflight.run("k", p.fn, { notBefore: before });
    expect(p.calls).toBe(1); // the floor is satisfied — joined, nothing restarted
    p.release();
    expect(await Promise.all([a, b])).toEqual([1, 1]); // same body, same result
  });

  test("a floor NEWER than the live flight supersedes it: two bodies, onSupersede once, and the superseder never reports onWait", async () => {
    const inflight = createInflight();
    const p = parked();
    const waits: number[] = [];
    const supersedes: number[] = [];
    const a = inflight.run("k", p.fn);
    await tick();
    const floor = performance.now(); // strictly after the first flight started
    const b = inflight.run("k", p.fn, {
      notBefore: floor,
      onWait: (ms) => waits.push(ms),
      onSupersede: () => supersedes.push(1),
    });

    expect(p.calls).toBe(2); // refused the old flight and started its own
    expect(supersedes).toHaveLength(1); // announced exactly once
    // A superseder is a STARTER: it waits for nothing, so `onWait` — which times
    // the await of somebody else's flight — must stay silent. Reporting it would
    // charge the caller a coalesce-wait it never paid.
    p.release();
    expect(await Promise.all([a, b])).toEqual([1, 2]); // distinct bodies, distinct results
    expect(waits).toEqual([]);
  });

  test("a caller arriving after a supersession joins the FRESH flight, not the superseded one", async () => {
    const inflight = createInflight();
    const p = parked();
    const a = inflight.run("k", p.fn);
    await tick();
    const b = inflight.run("k", p.fn, { notBefore: performance.now() });
    const c = inflight.run("k", p.fn); // no floor — takes whatever holds the key
    expect(p.calls).toBe(2); // c started nothing
    p.release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(1);
    expect(rb).toBe(2);
    expect(rc).toBe(2); // the fresh flight, never the one that was refused
  });

  test("the OLD flight settling does not evict the newer entry (identity-checked release)", async () => {
    // Two flights are live under one key after a supersession. An unconditional
    // `pending.delete(key)` in the old one's `finally` would drop the NEW entry:
    // the next arrival would start a third redundant body — and, worse, could
    // then join a flight that had already been refused as too old.
    const inflight = createInflight();
    let calls = 0;
    let openOld!: () => void;
    let openNew!: () => void;
    const oldGate = new Promise<void>((r) => (openOld = r));
    const newGate = new Promise<void>((r) => (openNew = r));
    const first = inflight.run("k", async () => {
      calls++;
      await oldGate;
      return "old";
    });
    await tick();
    const second = inflight.run(
      "k",
      async () => {
        calls++;
        await newGate;
        return "new";
      },
      { notBefore: performance.now() },
    );

    openOld(); // the SUPERSEDED flight settles first
    expect(await first).toBe("old");
    await tick();
    expect(inflight.size).toBe(1); // the fresh flight still holds the key

    // A caller arriving now joins the fresh flight rather than starting a third.
    const third = inflight.run("k", async () => {
      calls++;
      return "third";
    });
    openNew();
    expect(await Promise.all([second, third])).toEqual(["new", "new"]);
    expect(calls).toBe(2);
    expect(inflight.size).toBe(0); // and now the key is free
  });

  test("a REJECTED superseded flight clears cleanly: it neither evicts the fresh entry nor leaves a poisoned key", async () => {
    const inflight = createInflight();
    let openOld!: () => void;
    const oldGate = new Promise<void>((r) => (openOld = r));
    const first = inflight.run("k", async () => {
      await oldGate;
      throw new Error("stale boom");
    });
    await tick();
    const second = inflight.run("k", async () => "fresh", {
      notBefore: performance.now(),
    });

    openOld();
    expect(first).rejects.toThrow("stale boom");
    expect(await second).toBe("fresh"); // the rejection is the old flight's alone
    await tick();
    expect(inflight.size).toBe(0);
    expect(await inflight.run("k", async () => "after")).toBe("after");
  });

  test("supersession is ONE hop, not a chain: a fresh flight satisfies every floor stamped before it started", async () => {
    // Termination. A floor read after the superseding flight began is satisfied by
    // it, so a burst of floored callers costs one extra body in total — never one
    // per caller, and never a flight that keeps being replaced before it settles.
    const inflight = createInflight();
    const p = parked();
    const a = inflight.run("k", p.fn);
    await tick();
    const floor = performance.now();
    const runs = [
      inflight.run("k", p.fn, { notBefore: floor }),
      inflight.run("k", p.fn, { notBefore: floor }),
      inflight.run("k", p.fn, { notBefore: floor }),
    ];
    expect(p.calls).toBe(2); // one supersession, then joins
    p.release();
    expect(await Promise.all([a, ...runs])).toEqual([1, 2, 2, 2]);
  });

  test("`size` counts keys, not flights: a superseded flight still running is not counted", async () => {
    const inflight = createInflight();
    const p = parked();
    const a = inflight.run("k", p.fn);
    await tick();
    const b = inflight.run("k", p.fn, { notBefore: performance.now() });
    expect(p.calls).toBe(2); // two bodies in the air…
    expect(inflight.size).toBe(1); // …one key
    p.release();
    await Promise.all([a, b]);
  });

  test("onWait still fires for an ordinary joiner that passes a satisfied floor", async () => {
    // The floor and the wait metric are orthogonal: refusing changes who reports,
    // not whether joiners report at all.
    const inflight = createInflight();
    const p = parked();
    const waits: number[] = [];
    const before = performance.now();
    const a = inflight.run("k", p.fn);
    await tick();
    const b = inflight.run("k", p.fn, {
      notBefore: before,
      onWait: (ms) => waits.push(ms),
    });
    p.release();
    await Promise.all([a, b]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(0);
  });

  test("a detached flight takes no new joiner; its own joiners still share it", async () => {
    const inflight = createInflight();
    let detach!: () => void;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = async (flight: { detach(): void }) => {
      calls++;
      detach = () => flight.detach();
      await gate;
      return calls;
    };
    const a = inflight.run("k", body);
    const joined = inflight.run("k", body); // joins before the detach
    await tick();
    detach();
    expect(inflight.size).toBe(0);
    const fresh = inflight.run("k", body); // starts its own flight
    expect(calls).toBe(2);
    release();
    expect(await a).toBe(await joined);
    await fresh;
  });

  test("a detach before the body's first await still keeps the flight out of the key", async () => {
    const inflight = createInflight();
    let calls = 0;
    const a = inflight.run("k", async (flight) => {
      calls++;
      flight.detach();
      await tick();
    });
    const b = inflight.run("k", async () => {
      calls++;
    });
    expect(calls).toBe(2);
    await Promise.all([a, b]);
  });
});
