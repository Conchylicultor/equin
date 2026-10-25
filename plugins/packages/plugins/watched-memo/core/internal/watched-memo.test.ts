import { describe, expect, test } from "bun:test";
import { createWatchedMemo } from "./watched-memo";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued continuation run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A fake source: `content` is what compute reads LIVE (a diff of the tree),
 * `dirty` what facts read (a status scan). `gateNext` holds each compute,
 * after its read, until its gate is released; `fail` makes facts throw.
 */
function world() {
  const w = {
    content: "c0",
    dirty: "d0",
    facts: 0,
    computes: 0,
    signatures: 0,
    fail: null as Error | null,
    gates: [] as Deferred<void>[],
    gateNext: false,
    trigger: null as ((resync?: true) => void) | null,
    stops: 0,
    open: null as Deferred<void> | null,
    openError: null as Error | null,
  };
  const memo = createWatchedMemo<{ content: string; dirty: string }, string>({
    name: "test",
    facts: async () => {
      w.facts += 1;
      if (w.fail !== null) throw w.fail;
      return w.dirty;
    },
    signatureOf: async (_key, facts) => {
      w.signatures += 1;
      return `${facts}|${w.content}`;
    },
    compute: async (_key, facts) => {
      w.computes += 1;
      // Read first, then (maybe) held: a change landing while held is one
      // this pass has not seen.
      const content = w.content;
      if (w.gateNext) {
        const gate = deferred();
        w.gates.push(gate);
        await gate.promise;
      }
      return { content, dirty: facts };
    },
    changes: async (_key, trigger) => {
      if (w.open !== null) await w.open.promise;
      if (w.openError !== null) throw w.openError;
      w.trigger = trigger;
      return () => {
        w.stops += 1;
        w.trigger = null;
      };
    },
  });
  return { w, memo };
}

describe("createWatchedMemo — watched", () => {
  test("N gets while opening cost one facts read and one compute", async () => {
    const { w, memo } = world();
    const stop = await memo.watch("k", () => {});
    const gets = await Promise.all(
      Array.from({ length: 5 }, () => memo.get("k")),
    );
    expect(w.facts).toBe(1);
    expect(w.computes).toBe(1);
    expect(w.signatures).toBe(0);
    expect(new Set(gets).size).toBe(1);
    expect(gets[0]).toEqual({ content: "c0", dirty: "d0" });
    stop();
  });

  test("a watched get reads nothing", async () => {
    const { w, memo } = world();
    const stop = await memo.watch("k", () => {});
    await memo.get("k");
    const before = { facts: w.facts, computes: w.computes };
    await memo.get("k");
    await memo.get("k");
    expect({ facts: w.facts, computes: w.computes }).toEqual(before);
    stop();
  });

  test("pass 1 notifies nobody", async () => {
    const { memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    await settle();
    expect(notified).toBe(0);
    stop();
  });

  test("a change is one pass and one notify, the value set before it", async () => {
    const { w, memo } = world();
    const seen: unknown[] = [];
    const stop = await memo.watch("k", () => {
      seen.push(memo.get("k"));
    });
    await memo.get("k");
    w.content = "c1";
    w.trigger!();
    await settle();
    expect(seen.length).toBe(1);
    expect(await seen[0]).toEqual({ content: "c1", dirty: "d0" });
    stop();
  });

  test("triggers landing mid-pass are one trailing pass and one notify", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    w.gateNext = true;
    w.content = "c1";
    w.trigger!();
    await settle();
    expect(w.computes).toBe(2);
    // Three more changes while the pass is held.
    w.content = "c2";
    w.trigger!();
    w.trigger!();
    w.trigger!();
    w.gateNext = false;
    w.gates[0]!.resolve();
    await settle();
    expect(w.computes).toBe(3);
    // c1 then c2: each a real move. The held c1 pass started before c2.
    expect(notified).toBe(2);
    expect(await memo.get("k")).toEqual({ content: "c2", dirty: "d0" });
    stop();
  });

  test("a write made and undone mid-pass is corrected by the trailing pass", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    w.gateNext = true;
    w.content = "c1"; // the write
    w.trigger!();
    await settle(); // the pass has read c1, and is held
    w.content = "c0"; // undone — the dirty facts never moved
    w.trigger!();
    w.gateNext = false;
    w.gates[0]!.resolve();
    await settle();
    expect(w.computes).toBe(3);
    expect(notified).toBe(2); // c1, then back to c0
    expect(await memo.get("k")).toEqual({ content: "c0", dirty: "d0" });
    stop();
  });

  test("an equal value keeps the held object and notifies nobody", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    const before = await memo.get("k");
    w.trigger!();
    await settle();
    expect(w.computes).toBe(2);
    expect(notified).toBe(0);
    expect(await memo.get("k")).toBe(before);
    stop();
  });

  test("a failed pass demotes: watchers hear it, get throws through the probe path, a later pass restores", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    w.fail = new Error("gone");
    w.trigger!();
    await settle();
    expect(notified).toBe(1);
    expect(memo.get("k")).rejects.toThrow("gone");
    await settle();

    w.fail = null;
    w.content = "c1";
    w.trigger!();
    await settle();
    expect(notified).toBe(2);
    const facts = w.facts;
    expect(await memo.get("k")).toEqual({ content: "c1", dirty: "d0" });
    // Watched again: no probe.
    expect(w.facts).toBe(facts);
    stop();
  });

  test("a resync triggers a pass", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    w.content = "c1";
    w.trigger!(true);
    await settle();
    expect(w.computes).toBe(2);
    expect(notified).toBe(1);
    stop();
  });

  test("watchers of one key share one source and one pass", async () => {
    const { w, memo } = world();
    let a = 0;
    let b = 0;
    const stopA = await memo.watch("k", () => {
      a += 1;
    });
    const stopB = await memo.watch("k", () => {
      b += 1;
    });
    await memo.get("k");
    w.content = "c1";
    w.trigger!();
    await settle();
    expect(w.computes).toBe(2);
    expect([a, b]).toEqual([1, 1]);
    stopA();
    expect(w.stops).toBe(0);
    stopB();
    expect(w.stops).toBe(1);
  });
});

describe("createWatchedMemo — first settles", () => {
  test("on open failure: watch rejects, a waiting get takes the probe path", async () => {
    const { w, memo } = world();
    w.open = deferred();
    w.openError = new Error("unwatchable");
    const watching = memo.watch("k", () => {});
    const got = memo.get("k");
    w.open.resolve();
    expect(watching).rejects.toThrow("unwatchable");
    expect(await got).toEqual({ content: "c0", dirty: "d0" });
    // Probe path: facts + signature + compute + re-probe.
    expect(w.signatures).toBe(2);
  });

  test("on pass-1 failure: the waiting get raises through the probe path", async () => {
    const { w, memo } = world();
    w.fail = new Error("broken");
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    expect(memo.get("k")).rejects.toThrow("broken");
    await settle();
    expect(notified).toBe(0);
    stop();
  });

  test("on release while pass 1 runs: the waiting get takes the probe path at once", async () => {
    const { w, memo } = world();
    w.gateNext = true;
    const stop = await memo.watch("k", () => {});
    const got = memo.get("k");
    await settle();
    stop();
    w.gateNext = false;
    // Answered by the probe path without waiting on the held pass.
    expect(await got).toEqual({ content: "c0", dirty: "d0" });
    w.gates[0]!.resolve();
    await settle();
  });
});

describe("createWatchedMemo — close", () => {
  test("a pass landing after close writes nothing and notifies nobody", async () => {
    const { w, memo } = world();
    let notified = 0;
    const stop = await memo.watch("k", () => {
      notified += 1;
    });
    await memo.get("k");
    w.gateNext = true;
    w.content = "c1";
    w.trigger!();
    await settle();
    stop();
    w.gates[0]!.resolve();
    await settle();
    expect(notified).toBe(0);
    // Reopened: a fresh pass 1, not the late write.
    w.gateNext = false;
    w.content = "c2";
    const again = await memo.watch("k", () => {});
    expect(await memo.get("k")).toEqual({ content: "c2", dirty: "d0" });
    again();
  });
});

describe("createWatchedMemo — probe path (unwatched)", () => {
  test("a hit reads facts and the signature, never computes", async () => {
    const { w, memo } = world();
    const first = await memo.get("k");
    expect(w.computes).toBe(1);
    const second = await memo.get("k");
    expect(second).toBe(first);
    expect(w.computes).toBe(1);
  });

  test("a miss computes over the probe's facts", async () => {
    const { w, memo } = world();
    await memo.get("k");
    w.dirty = "d1";
    expect(await memo.get("k")).toEqual({ content: "c0", dirty: "d1" });
    expect(w.computes).toBe(2);
  });

  test("concurrent misses at one signature are one compute", async () => {
    const { w, memo } = world();
    const all = await Promise.all([
      memo.get("k"),
      memo.get("k"),
      memo.get("k"),
    ]);
    expect(w.computes).toBe(1);
    expect(new Set(all).size).toBe(1);
  });

  test("a value whose signature moved during its compute is not cached", async () => {
    const { w, memo } = world();
    w.gateNext = true;
    const got = memo.get("k");
    await settle();
    w.content = "c1";
    w.gateNext = false;
    w.gates[0]!.resolve();
    await got;
    // The re-probe read c1, so nothing was cached: the next get computes.
    await memo.get("k");
    expect(w.computes).toBe(2);
  });

  test("evict drops the cached entry", async () => {
    const { w, memo } = world();
    await memo.get("k");
    memo.evict("k");
    await memo.get("k");
    expect(w.computes).toBe(2);
  });
});
