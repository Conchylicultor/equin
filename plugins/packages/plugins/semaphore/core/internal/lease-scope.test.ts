import { AsyncLocalStorage } from "node:async_hooks";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { createSemaphore } from "./semaphore";
import {
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "./lease-scope";

beforeAll(() => {
  const als = new AsyncLocalStorage<LeaseScope>();
  installLeaseContextRuntime({
    run: (scope, fn) => als.run(scope, fn),
    current: () => als.getStore(),
  });
});
afterAll(() => installLeaseContextRuntime(null));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
const USES = { heldFor: ["db", "fs"] } as const;

describe("use-scoped slots", () => {
  // The class of bug this replaces: a body holding its slot while it waits on
  // something that is not a resource use (a worker reply, a child process,
  // another caller's flight, a mutex) — under the old held-by-default slot this
  // test hangs: the second run never gets the only slot.
  test("a body awaiting anything but a use holds no slot", async () => {
    const gate = createSemaphore(1);
    const worker = deferred<string>();
    const waiter = gate.run(() => worker.promise, USES);
    await flush();
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
    expect(await gate.run(() => Promise.resolve("unrelated"))).toBe(
      "unrelated",
    );
    worker.resolve("reply");
    expect(await waiter).toBe("reply");
  });

  test("a use holds the slot for exactly its length", async () => {
    const gate = createSemaphore(1);
    const query = deferred<number>();
    const after = deferred();
    const body = gate.run(async () => {
      const rows = await usingSlot("db", () => query.promise);
      await after.promise; // not a use: holds nothing
      return rows;
    }, USES);
    await flush();
    expect(gate.stats()).toMatchObject({ active: 1 });
    let other = false;
    const next = gate.run(async () => {
      other = true;
    });
    await flush();
    expect(other).toBe(false); // queued behind the running query
    query.resolve(3);
    await next;
    expect(other).toBe(true);
    expect(gate.stats().active).toBe(0);
    after.resolve();
    expect(await body).toBe(3);
  });

  test("a use started in the body's synchronous start keeps the admitted slot", async () => {
    const gate = createSemaphore(1);
    const query = deferred();
    const body = gate.run(() => usingSlot("fs", () => query.promise), USES);
    await flush();
    expect(gate.stats()).toMatchObject({ active: 1, queued: 0 });
    query.resolve();
    await body;
    expect(gate.stats().active).toBe(0);
  });

  test("a use takes its slot back ahead of newcomers, FIFO among take-backs", async () => {
    const gate = createSemaphore(1);
    const order: string[] = [];
    const blocker = deferred();
    const waits = [deferred(), deferred()];
    // Two admitted bodies, each waiting (holding nothing), then making a use.
    const bodies = ["a", "b"].map((name, i) =>
      gate.run(async () => {
        await waits[i]!.promise;
        await usingSlot("db", async () => {
          order.push(name);
        });
      }, USES),
    );
    await flush();
    // The gate is now taken by an unrelated holder; a newcomer queues.
    const holder = gate.run(() => blocker.promise);
    await flush();
    const newcomer = gate.run(async () => {
      order.push("newcomer");
    });
    waits[0]!.resolve(); // a's take-back queues first...
    await flush();
    waits[1]!.resolve(); // ...then b's, both ahead of the newcomer
    await flush();
    blocker.resolve();
    await Promise.all([...bodies, holder, newcomer]);
    expect(order).toEqual(["a", "b", "newcomer"]);
  });

  test("concurrent uses of one body share one slot", async () => {
    const gate = createSemaphore(2);
    const x = deferred();
    const y = deferred();
    const body = gate.run(
      () =>
        Promise.all([
          usingSlot("db", () => x.promise),
          usingSlot("fs", () => y.promise),
        ]),
      USES,
    );
    await flush();
    expect(gate.stats().active).toBe(1);
    x.resolve();
    await flush();
    expect(gate.stats().active).toBe(1); // y still running
    y.resolve();
    await body;
    expect(gate.stats().active).toBe(0);
  });

  test("a use of a kind the slot is not held for takes nothing from it", async () => {
    const gate = createSemaphore(1);
    const child = deferred();
    const body = gate.run(() => usingSlot("spawn", () => child.promise), USES);
    await flush();
    expect(gate.stats().active).toBe(0);
    child.resolve();
    await body;
  });

  test("a lazy gate (admit: false) is taken only by a use", async () => {
    const spawns = createSemaphore(1);
    const children = [deferred(), deferred()];
    const started: number[] = [];
    const lazy = { heldFor: ["spawn"], admit: false } as const;
    const bodies = [0, 1].map((i) =>
      spawns.run(
        () =>
          usingSlot("spawn", () => {
            started.push(i);
            return children[i]!.promise;
          }),
        lazy,
      ),
    );
    // A lazy body that never spawns never waits.
    expect(await spawns.run(() => Promise.resolve("no child"), lazy)).toBe(
      "no child",
    );
    await flush();
    expect(started).toEqual([0]); // the second child waits for the slot
    children[0]!.resolve();
    await flush();
    expect(started).toEqual([0, 1]);
    children[1]!.resolve();
    await Promise.all(bodies);
    expect(spawns.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("a use finds the innermost slot held for its kind across nested gates", async () => {
    const reads = createSemaphore(1);
    const spawns = createSemaphore(1);
    const child = deferred();
    const query = deferred();
    const body = spawns.run(
      () =>
        reads.run(
          () =>
            Promise.all([
              usingSlot("spawn", () => child.promise),
              usingSlot("db", () => query.promise),
            ]),
          USES,
        ),
      { heldFor: ["spawn"], admit: false },
    );
    await flush();
    expect(spawns.stats().active).toBe(1);
    expect(reads.stats().active).toBe(1);
    query.resolve();
    await flush();
    expect(reads.stats().active).toBe(0); // the child holds no read slot
    expect(spawns.stats().active).toBe(1);
    child.resolve();
    await body;
    expect(spawns.stats().active).toBe(0);
  });

  test("a nested gated body: the outer holds nothing while it awaits the inner", async () => {
    const gate = createSemaphore(1);
    const query = deferred();
    const outer = gate.run(
      () => gate.run(() => usingSlot("db", () => query.promise), USES),
      USES,
    );
    await flush();
    // Only the inner body's use holds the one slot: no self-deadlock.
    expect(gate.stats()).toMatchObject({ active: 1, queued: 0 });
    query.resolve();
    await outer;
    expect(gate.stats().active).toBe(0);
  });

  test("a use after the body settled holds nothing", async () => {
    const gate = createSemaphore(1);
    let stray: Promise<void> | undefined;
    const late = deferred();
    await gate.run(async () => {
      stray = (async () => {
        await late.promise;
        await usingSlot("db", () => Promise.resolve());
      })();
    }, USES);
    late.resolve();
    await stray;
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("a use the body left open keeps the slot until it ends", async () => {
    const gate = createSemaphore(1);
    const checkout = deferred();
    let open: Promise<void> | undefined;
    await gate.run(async () => {
      open = usingSlot("db", () => checkout.promise); // released later
    }, USES);
    expect(gate.stats().active).toBe(1);
    checkout.resolve();
    await open;
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("a plain slot held around a use cannot deadlock the use-scoped gate", async () => {
    // The 2026-11-05 shape: a read takes a plain peek gate around a readdir.
    // The readdir's take-back waits only for a read slot, whose holders are
    // themselves uses — so it always comes.
    const reads = createSemaphore(1);
    const peeks = createSemaphore(1);
    const disk = [deferred(), deferred()];
    const done = [0, 1].map((i) =>
      reads.run(
        () => peeks.run(() => usingSlot("fs", () => disk[i]!.promise)),
        USES,
      ),
    );
    await flush();
    disk[0]!.resolve();
    disk[1]!.resolve();
    await Promise.all(done);
    expect(reads.stats()).toMatchObject({ active: 0, queued: 0 });
    expect(peeks.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("a use's take-back keeps its class's share", async () => {
    const gate = createSemaphore(2, { perClass: 1 });
    const q = [deferred(), deferred()];
    const waits = [deferred(), deferred()];
    const ran: number[] = [];
    const bodies = [0, 1].map((i) =>
      gate.run(
        async () => {
          await waits[i]!.promise;
          await usingSlot("db", () => {
            ran.push(i);
            return q[i]!.promise;
          });
        },
        { ...USES, class: "a" },
      ),
    );
    await flush();
    waits[0]!.resolve();
    waits[1]!.resolve();
    await flush();
    expect(ran).toEqual([0]); // class "a" holds its one-slot share
    q[0]!.resolve();
    await flush();
    expect(ran).toEqual([0, 1]);
    q[1]!.resolve();
    await Promise.all(bodies);
  });

  test("labelled holders are listed only while a use holds the slot", async () => {
    const gate = createSemaphore(1);
    const query = deferred();
    const wait = deferred();
    const body = gate.run(
      async () => {
        await wait.promise;
        await usingSlot("db", () => query.promise);
      },
      { ...USES, label: "read x" },
    );
    await flush();
    expect(gate.stats().holders).toEqual([]);
    wait.resolve();
    await flush();
    expect(gate.stats().holders.map((h) => h.label)).toEqual(["read x"]);
    query.resolve();
    await body;
    expect(gate.stats().holders).toEqual([]);
  });
});
