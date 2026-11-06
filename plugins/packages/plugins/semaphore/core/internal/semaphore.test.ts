import { describe, expect, test } from "bun:test";
import { createSemaphore } from "./semaphore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createSemaphore", () => {
  test("rejects a non-positive or non-integer max", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-1)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
  });

  test("never exceeds max concurrent bodies", async () => {
    const sem = createSemaphore(3);
    let active = 0;
    let peak = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    const tasks = Array.from({ length: 10 }, () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
      }),
    );

    await tick();
    expect(active).toBe(3); // exactly max admitted, rest queued
    open();
    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  test("admits queued waiters in FIFO order", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) =>
      sem.run(async () => {
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]);
  });

  test("reports wait time via onWait — ~0 when free, positive when queued", async () => {
    const sem = createSemaphore(1);
    const waits: number[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    // First holder acquires immediately (no wait) and parks on the gate.
    const first = sem.run(
      async () => {
        await gate;
      },
      { onWait: (ms) => waits.push(ms) },
    );
    // Second must queue behind the first, so its onWait is positive.
    const second = sem.run(async () => {}, { onWait: (ms) => waits.push(ms) });

    await tick();
    expect(waits).toEqual([expect.any(Number)]); // only the immediate holder reported so far
    expect(waits[0]!).toBeLessThan(5); // acquired without queueing
    open();
    await Promise.all([first, second]);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(0); // genuinely waited for the slot
  });

  test("stats() reports active/queued/max through fill, saturation, and drain", async () => {
    const sem = createSemaphore(2);
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });

    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        await gate;
      }),
    );

    await tick();
    // 2 hold slots, the other 3 queue behind them.
    expect(sem.stats()).toEqual({ active: 2, queued: 3, max: 2, holders: [] });

    open();
    await Promise.all(tasks);
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("releases the slot when the body rejects", async () => {
    const sem = createSemaphore(1);
    let message: string | undefined;
    try {
      await sem.run(async () => {
        throw new Error("boom");
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("boom");
    // Slot must be free again — this would hang if the rejection leaked it.
    expect(await sem.run(async () => "ok")).toBe("ok");
  });

  test("acquire blocks past max and hands slots to waiters in FIFO order", async () => {
    const sem = createSemaphore(2);
    const admitted: number[] = [];

    const leases = [0, 1, 2, 3].map((i) =>
      sem.acquire().then((release) => {
        admitted.push(i);
        return release;
      }),
    );

    await tick();
    expect(admitted).toEqual([0, 1]); // exactly max admitted, rest queued
    expect(sem.stats()).toEqual({ active: 2, queued: 2, max: 2, holders: [] });

    // Freeing one slot admits exactly the head waiter, not the tail.
    (await leases[0]!)();
    await tick();
    expect(admitted).toEqual([0, 1, 2]);

    (await leases[1]!)();
    await tick();
    expect(admitted).toEqual([0, 1, 2, 3]);

    (await leases[2]!)();
    (await leases[3]!)();
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("the release fn is idempotent — a double release frees only one slot", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();

    const admitted: number[] = [];
    const second = sem.acquire().then((r) => {
      admitted.push(1);
      return r;
    });
    const third = sem.acquire().then((r) => {
      admitted.push(2);
      return r;
    });

    release();
    release(); // a second free would hand the same slot out twice
    await tick();

    // Only the head waiter got in; the third is still queued behind the one live slot.
    expect(admitted).toEqual([1]);
    expect(sem.stats()).toEqual({ active: 1, queued: 1, max: 1, holders: [] });

    (await second)();
    await tick();
    expect(admitted).toEqual([1, 2]);
    (await third)();
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 1, holders: [] });
  });

  test("acquire reports wait time via onWait — ~0 when free, positive when queued", async () => {
    const sem = createSemaphore(1);
    const waits: number[] = [];

    const release = await sem.acquire({ onWait: (ms) => waits.push(ms) });
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeLessThan(5); // acquired without queueing

    // Second must queue behind the first, so its onWait is positive.
    const queued = sem.acquire({ onWait: (ms) => waits.push(ms) });
    await tick();
    expect(waits).toHaveLength(1); // nothing reported while still queued

    release();
    (await queued)();
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(0); // genuinely waited for the slot
  });

  test("stats() stays accurate across mixed run + acquire usage", async () => {
    const sem = createSemaphore(2);
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    const lease = await sem.acquire();
    const running = sem.run(async () => {
      await gate;
    });
    const queued = sem.run(async () => {});

    await tick();
    expect(sem.stats()).toEqual({ active: 2, queued: 1, max: 2, holders: [] });

    // The lease hands its slot to the queued `run` body, which completes at once.
    lease();
    await queued;
    expect(sem.stats()).toEqual({ active: 1, queued: 0, max: 2, holders: [] });

    open();
    await running;
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("a weighted caller takes its whole weight, atomically", async () => {
    const sem = createSemaphore(2);
    const running = new Set<string>();
    const overlaps: string[][] = [];
    const open: Record<string, () => void> = {};
    const gates: Record<string, Promise<void>> = {};
    for (const id of ["heavy-a", "heavy-b", "light"]) {
      gates[id] = new Promise<void>((r) => {
        open[id] = r;
      });
    }
    const body = (id: string, weight: number) =>
      sem.run(
        async () => {
          running.add(id);
          overlaps.push([...running]);
          await gates[id]!;
          running.delete(id);
        },
        { weight },
      );

    const a = body("heavy-a", 2);
    const b = body("heavy-b", 2);
    const light = body("light", 1);

    await tick();
    // The first heavy body holds BOTH units, so nothing else fits — not the other
    // heavy one, and not the light one either.
    expect(sem.stats()).toEqual({ active: 2, queued: 2, max: 2, holders: [] });

    open["heavy-a"]!();
    await tick();
    expect(sem.stats()).toEqual({ active: 2, queued: 1, max: 2, holders: [] });
    open["heavy-b"]!();
    await tick();
    expect(sem.stats()).toEqual({ active: 1, queued: 0, max: 2, holders: [] });
    open["light"]!();
    await Promise.all([a, b, light]);

    // Every admission saw itself alone: a weight is all-or-nothing, so a heavy
    // body never ran half-acquired beside anyone.
    expect(overlaps).toEqual([["heavy-a"], ["heavy-b"], ["light"]]);
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("a queued heavy waiter is never overtaken by a lighter one that would fit", async () => {
    const sem = createSemaphore(2);
    const admitted: string[] = [];
    let openLight!: () => void;
    let openHeavy!: () => void;
    const lightGate = new Promise<void>((r) => {
      openLight = r;
    });
    const heavyGate = new Promise<void>((r) => {
      openHeavy = r;
    });

    const light0 = sem.run(async () => {
      admitted.push("light0");
      await lightGate;
    });
    await tick();
    expect(sem.stats()).toEqual({ active: 1, queued: 0, max: 2, holders: [] });

    // Needs both units, so it queues with one unit free.
    const heavy = sem.run(
      async () => {
        admitted.push("heavy");
        await heavyGate;
      },
      { weight: 2 },
    );
    // This one WOULD fit in the free unit — strict FIFO keeps it behind the heavy
    // waiter, which is what stops a stream of light callers from starving it.
    const light1 = sem.run(async () => {
      admitted.push("light1");
    });

    await tick();
    expect(admitted).toEqual(["light0"]);
    expect(sem.stats()).toEqual({ active: 1, queued: 2, max: 2, holders: [] });

    openLight();
    await tick();
    expect(admitted).toEqual(["light0", "heavy"]);
    expect(sem.stats()).toEqual({ active: 2, queued: 1, max: 2, holders: [] });

    openHeavy();
    await Promise.all([light0, heavy, light1]);
    expect(admitted).toEqual(["light0", "heavy", "light1"]);
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("rejects a weight that could never be admitted, at the call site", () => {
    const sem = createSemaphore(2);
    // Throws synchronously — not a rejected promise nobody is awaiting yet.
    expect(() => sem.run(async () => {}, { weight: 3 })).toThrow(/exceeds max/);
    expect(() => sem.acquire({ weight: 3 })).toThrow(/exceeds max/);
    expect(() => sem.run(async () => {}, { weight: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => sem.acquire({ weight: 1.5 })).toThrow(/positive integer/);
    // A refused request never touched the gate.
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 2, holders: [] });
  });

  test("releasing a weighted lease frees all of its weight, exactly once", async () => {
    const sem = createSemaphore(3);
    const release = await sem.acquire({ weight: 3 });
    expect(sem.stats()).toEqual({ active: 3, queued: 0, max: 3, holders: [] });

    const admitted: number[] = [];
    const queued = [1, 2, 3].map((i) =>
      sem.acquire().then((r) => {
        admitted.push(i);
        return r;
      }),
    );
    await tick();
    expect(admitted).toEqual([]); // all three units are held by the one lease

    release();
    release(); // idempotent, weighted or not
    await tick();
    // The freed weight is handed down the queue while each waiter still fits.
    expect(admitted).toEqual([1, 2, 3]);
    expect(sem.stats()).toEqual({ active: 3, queued: 0, max: 3, holders: [] });

    for (const q of queued) (await q)();
    expect(sem.stats()).toEqual({ active: 0, queued: 0, max: 3, holders: [] });
  });

  test("onWait fires once for a weighted caller, at its acquisition", async () => {
    const sem = createSemaphore(2);
    const waits: number[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });

    const holder = sem.run(
      async () => {
        await gate;
      },
      { weight: 2, onWait: (ms) => waits.push(ms) },
    );
    const queued = sem.run(async () => {}, {
      weight: 2,
      onWait: (ms) => waits.push(ms),
    });

    await tick();
    expect(waits).toHaveLength(1); // only the immediate holder reported so far
    expect(waits[0]!).toBeLessThan(5);

    open();
    await Promise.all([holder, queued]);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(0); // genuinely waited for the full weight
  });

  test("stats().holders names the labelled callers holding a slot, longest first", async () => {
    const sem = createSemaphore(2);
    let openA!: () => void;
    let openB!: () => void;
    const a = sem.run(
      () =>
        new Promise<void>((r) => {
          openA = r;
        }),
      { label: "a" },
    );
    await tick();
    const b = sem.run(
      () =>
        new Promise<void>((r) => {
          openB = r;
        }),
      { label: "b" },
    );
    // Queued: holds nothing, so it is not a holder.
    const c = sem.run(async () => {}, { label: "c" });
    await tick();
    expect(sem.stats().holders.map((h) => h.label)).toEqual(["a", "b"]);
    openA();
    await a;
    await c;
    expect(sem.stats().holders.map((h) => h.label)).toEqual(["b"]);
    openB();
    await b;
    expect(sem.stats().holders).toEqual([]);
  });

  test("an unlabelled caller holds capacity but is not listed", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    expect(sem.stats()).toEqual({
      active: 1,
      queued: 0,
      max: 1,
      holders: [],
    });
    release();
  });

  test("perClass: a class at its share is passed over; other callers keep FIFO order", async () => {
    const sem = createSemaphore(4, { perClass: 2 });
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const hold = (name: string, cls: string) =>
      sem.run(
        async () => {
          order.push(name);
          await gate;
        },
        { class: cls },
      );
    const runs = [
      hold("a1", "a"),
      hold("a2", "a"),
      hold("a3", "a"), // a at its share: passed over
      hold("b1", "b"),
      hold("c1", "c"),
      hold("d1", "d"), // gate full
    ];
    await tick();
    expect(order).toEqual(["a1", "a2", "b1", "c1"]);
    expect(sem.stats()).toMatchObject({ active: 4, queued: 2 });
    open();
    await Promise.all(runs);
    expect(order.slice(4).sort()).toEqual(["a3", "d1"]);
    expect(sem.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("perClass: a freed slot of the capped class admits its waiter first in queue order", async () => {
    const sem = createSemaphore(2, { perClass: 1 });
    const order: string[] = [];
    let releaseA!: () => void;
    const a1 = sem.run(
      () =>
        new Promise<void>((r) => {
          order.push("a1");
          releaseA = r;
        }),
      { class: "a" },
    );
    const a2 = sem.run(async () => void order.push("a2"), { class: "a" });
    let releaseB!: () => void;
    const b1 = sem.run(
      () =>
        new Promise<void>((r) => {
          order.push("b1");
          releaseB = r;
        }),
      { class: "b" },
    );
    await tick();
    expect(order).toEqual(["a1", "b1"]);
    releaseA();
    await a1;
    await a2;
    expect(order).toEqual(["a1", "b1", "a2"]);
    releaseB();
    await b1;
  });

  test("perClass must fit max; a class is ignored on a gate without it", async () => {
    expect(() => createSemaphore(2, { perClass: 3 })).toThrow("perClass");
    const sem = createSemaphore(2);
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const runs = [1, 2].map(() => sem.run(() => gate, { class: "a" }));
    await tick();
    expect(sem.stats().active).toBe(2);
    open();
    await Promise.all(runs);
  });
});

describe("onQueued", () => {
  test("announces only a caller that queues, and ends it at admission before onWait", async () => {
    const sem = createSemaphore(1);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const observe = (name: string) => ({
      onQueued: () => {
        events.push(`${name} queued`);
        return () => events.push(`${name} admitted`);
      },
      onWait: () => events.push(`${name} waited`),
    });

    const first = sem.run(() => held, observe("a"));
    const second = sem.run(async () => {
      events.push("b runs");
    }, observe("b"));
    await tick();
    // `a` found room: it never queued. `b` queued at its call.
    expect(events.sort()).toEqual(["a waited", "b queued"]);

    events.length = 0;
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["b admitted", "b waited", "b runs"]);
  });

  test("an acquire lease announces its queueing the same way", async () => {
    const sem = createSemaphore(1);
    const releaseA = await sem.acquire();
    let ended = 0;
    const pending = sem.acquire({ onQueued: () => () => ended++ });
    await tick();
    expect(ended).toBe(0);
    releaseA();
    const releaseB = await pending;
    expect(ended).toBe(1);
    releaseB();
  });
});
