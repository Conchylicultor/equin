import { afterEach, describe, expect, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineDataDir, type DataDir } from "@plugins/infra/plugins/paths/core";
import { createHostSemaphore, type HostShare } from "./host-semaphore";

// Raw flock, the same way the module dials it — used by `isSlotHeld` below to probe
// which specific slot file a share is holding (flock conflicts across fds even within
// one process, so an in-process probe sees an in-process holder).
const { symbols: rawFfi } = dlopen(
  process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
  { flock: { args: ["i32", "i32"], returns: "i32" } },
);
const RAW_LOCK_EX = 2;
const RAW_LOCK_NB = 4;

/**
 * True iff `slot-<i>.lock` in `slotsDir` is currently flock-held by someone. Probes
 * non-blockingly: if we can take the lock it was free (we drop it immediately); if we
 * can't, it is held. Only call while the pool is otherwise quiescent — the probe
 * momentarily holds a free slot, which could race a concurrent acquirer.
 */
function isSlotHeld(slotsDir: string, i: number): boolean {
  const fd = openSync(join(slotsDir, `slot-${i}.lock`), "w");
  try {
    return rawFfi.flock(fd, RAW_LOCK_EX | RAW_LOCK_NB) !== 0;
  } finally {
    closeSync(fd);
  }
}

// The `flock-wait.ts` child script `waitForFlock` spawns (it lives in
// `packages/flock`). Tests spawn it directly to stand in for an out-of-process
// slot holder.
const FLOCK_WAIT_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "flock",
  "scripts",
  "flock-wait.ts",
);

// This very module, imported by the separate-process probe below. The probe must run
// inside the repo (default cwd under `bun test`) so the transitive `@plugins/*` alias
// resolves.
const HOST_SEMAPHORE_MODULE = join(import.meta.dir, "host-semaphore.ts");

// The paths plugin's `core` barrel, by absolute path for the same reason: the
// fixture needs `defineDataDir` to declare its throwaway pool directory, and a
// `bun -e` snippet has no file of its own for an `@plugins/*` alias to resolve
// against.
const PATHS_CORE_MODULE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "infra",
  "plugins",
  "paths",
  "core",
  "index.ts",
);

// A one-shot fixture (run via `bun -e`): construct the named pool and acquire+release
// one slot immediately, printing OK on success or THREW:<msg> on any error. Used to
// hammer a fresh pool's first-acquire from many separate processes at once.
const FIRST_ACQUIRE_FIXTURE = `
  const { createHostSemaphore } = await import(process.env.HS_MOD);
  const { defineDataDir } = await import(process.env.HS_PATHS_MOD);
  const sem = createHostSemaphore({
    slots: defineDataDir({
      kind: "locks",
      name: process.env.HS_NAME,
      owner: "packages/host-semaphore",
      description: "throwaway test pool",
      reclaim: { kind: "restart" },
    }),
    size: 4,
  });
  try {
    const share = await sem.acquireShare(1);
    await share.release();
    process.stdout.write("OK\\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write("THREW:" + (err && err.message) + "\\n");
    process.exit(1);
  }
`;

// A freshly DECLARED slot directory per pool, so parallel test runs (and the two
// tests below) never collide on the same lock files. Declaring it — rather than
// joining a path — is the point: `createHostSemaphore` no longer derives a
// directory, it is handed one, and these tests exercise the real API.
let counter = 0;
const usedDirs: DataDir[] = [];
function uniqueSlots(prefix: string): DataDir {
  const dir = defineDataDir({
    kind: "locks",
    name: `hosttest-${prefix}-${process.pid}-${Date.now()}-${counter++}`,
    owner: "packages/host-semaphore",
    description: "throwaway test pool",
    reclaim: { kind: "restart" },
  });
  usedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of usedDirs.splice(0)) {
    rmSync(dir.path, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Name validation is no longer here: the pool's name IS its declared directory's
// name, which `defineDataDir` validates against the same lowercase-kebab regex.
// One rule, one owner — the two can no longer disagree.
test("validates size", () => {
  expect(() =>
    createHostSemaphore({ slots: uniqueSlots("v0"), size: 0 }),
  ).toThrow();
  expect(() =>
    createHostSemaphore({ slots: uniqueSlots("v1"), size: 1.5 }),
  ).toThrow();
  expect(() =>
    createHostSemaphore({ slots: uniqueSlots("v2"), size: 1 }),
  ).not.toThrow();
});

describe("cross-process serialization", () => {
  test("size 1 serializes 3 overlapping runs through fast-path + broker", async () => {
    const sem = createHostSemaphore({ slots: uniqueSlots("s1"), size: 1 });

    let active = 0;
    let peak = 0;
    const order: number[] = [];

    async function job(id: number): Promise<void> {
      await sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await sleep(50);
        active--;
      });
    }

    // Launch all 3 overlapping: the first wins the in-process fast path; the
    // other two find every slot busy and queue via the blocking broker.
    await Promise.all([job(1), job(2), job(3)]);

    expect(peak).toBe(1); // never more than one body at a time
    expect(order.sort()).toEqual([1, 2, 3]); // all three ran
    expect(active).toBe(0); // every slot released
  });

  test("size 2 allows 2 concurrent but never 3", async () => {
    const sem = createHostSemaphore({ slots: uniqueSlots("s2"), size: 2 });

    let active = 0;
    let peak = 0;
    let sawTwo = false;

    async function job(): Promise<void> {
      await sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) sawTwo = true;
        await sleep(60);
        active--;
      });
    }

    await Promise.all([job(), job(), job(), job()]);

    expect(peak).toBe(2); // two slots → at most two bodies
    expect(sawTwo).toBe(true); // and it really did reach two (not just serialized)
    expect(active).toBe(0);
  });

  test("a rejecting fn never leaks a slot", async () => {
    const sem = createHostSemaphore({ slots: uniqueSlots("rej"), size: 1 });

    let rejected: unknown;
    try {
      await sem.run(async () => {
        throw new Error("boom");
      });
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("boom");

    // If the slot leaked, this immediate run would hang/queue. It must take the
    // fast path and resolve promptly.
    let ran = false;
    await sem.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

/**
 * Await `p` and return the Error it rejected with; throw if it resolved instead.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting it is
 * a no-op the assertion never actually runs behind — the test would pass even if
 * `p` resolved. This asserts the rejection for real, and hands back the error so
 * the caller can pin its message.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("acquireShare", () => {
  test("throws on a non-positive-integer max", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-arg"),
      size: 4,
    });
    // Failure is a thrown type, never a `slots: 0` value a caller could absorb.
    for (const bad of [0, -1, 1.5]) {
      expect((await rejection(sem.acquireShare(bad))).message).toContain(
        "positive integer",
      );
    }
  });

  test("on an idle pool takes the full share with no broker", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-idle"),
      size: 4,
    });

    // Spy on Bun.spawn to prove the fast path spawns no broker subprocess: on an
    // idle pool the whole share is grabbed in-process by the non-blocking sweep.
    const origSpawn = Bun.spawn;
    let spawnCount = 0;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      ...args: unknown[]
    ) => {
      spawnCount++;
      return (origSpawn as (...a: unknown[]) => unknown)(...args);
    }) as typeof Bun.spawn;

    try {
      const share = await sem.acquireShare(4);
      expect(share.slots).toBe(4); // all four free slots taken greedily
      expect(spawnCount).toBe(0); // no broker
      await share.release();
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }
  });

  test("with 3 of 4 slots held, returns the single remaining slot", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-partial"),
      size: 4,
    });

    // A holder (a distinct set of open file descriptions — flock conflicts even
    // within one process) parks on 3 of the 4 slots.
    const holder = await sem.acquireShare(3);
    expect(holder.slots).toBe(3);

    // The greedy sweep can only take what's free: exactly one slot, no broker.
    const share = await sem.acquireShare(4);
    expect(share.slots).toBe(1);

    await share.release();
    await holder.release();
  });

  test("with all 4 slots held, blocks then returns once one frees (broker path)", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-full"),
      size: 4,
    });

    const holder = await sem.acquireShare(4);
    expect(holder.slots).toBe(4);

    // Every slot busy → the sweep finds nothing → one broker does the blocking
    // wait off the event loop. The share must not resolve while all slots are held.
    let resolved = false;
    const pending = sem.acquireShare(4).then((s) => {
      resolved = true;
      return s;
    });
    await sleep(100);
    expect(resolved).toBe(false); // genuinely blocked on the broker

    await holder.release(); // frees the slots → broker grants
    const share = await pending;
    expect(share.slots).toBeGreaterThanOrEqual(1);
    expect(share.slots).toBeLessThanOrEqual(4);

    await share.release();
  });

  test("two concurrent callers never hold more than 4 slots at once", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-race"),
      size: 4,
    });

    const held = new Set<HostShare>();
    const totalHeld = () => [...held].reduce((n, s) => n + s.slots, 0);
    let peak = 0;

    async function worker(): Promise<void> {
      const share = await sem.acquireShare(4);
      held.add(share);
      peak = Math.max(peak, totalHeld());
      await sleep(40);
      held.delete(share);
      await share.release();
    }

    await Promise.all([worker(), worker()]);

    expect(peak).toBeLessThanOrEqual(4); // the host ceiling is never exceeded
    expect(held.size).toBe(0); // every share released
  });

  test("release is idempotent and leaks no slot when the caller's body throws", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("share-rej"),
      size: 4,
    });

    // Idempotent: a double release is a no-op, not a double-close error.
    const first = await sem.acquireShare(4);
    await first.release();
    await first.release();

    // No leak on a throwing body: release in the `finally` hands every slot back.
    let rejected: unknown;
    try {
      const share = await sem.acquireShare(4);
      try {
        throw new Error("boom");
      } finally {
        await share.release();
      }
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("boom");

    // If either the double-release or the throwing body had leaked a slot, this
    // fast-path acquire could not reclaim the whole pool.
    const again = await sem.acquireShare(4);
    expect(again.slots).toBe(4);
    await again.release();
  });
});

// The reserved-floor lane split. A size-4 pool with backgroundLimit-2 confines
// `background` to slot-0..1 and reserves slot-2..3 for `interactive`, which sweeps
// high-first. These four tests pin the window, the reverse order, the fast-path floor
// grant, and the split's presence in the pool identity.
describe("reserved floor (lanes)", () => {
  test("background never takes a slot at or above backgroundLimit", async () => {
    const slots = uniqueSlots("bg-floor");
    const slotsDir = slots.path;
    const sem = createHostSemaphore({ slots, size: 4, backgroundLimit: 2 });

    // Two background handles take the whole background window — deterministically
    // slot-0 then slot-1 (forward sweep, one slot each).
    const h1 = await sem.acquireShare(1, { lane: "background" });
    const h2 = await sem.acquireShare(1, { lane: "background" });
    expect(h1.slots).toBe(1);
    expect(h2.slots).toBe(1);
    expect(isSlotHeld(slotsDir, 0)).toBe(true);
    expect(isSlotHeld(slotsDir, 1)).toBe(true);
    expect(isSlotHeld(slotsDir, 2)).toBe(false); // reserved floor, untouched
    expect(isSlotHeld(slotsDir, 3)).toBe(false);

    // A 3rd background acquire must BLOCK — its window (slot-0..1) is full — even
    // though slot-2 and slot-3 sit free (reserved for interactive).
    let resolved = false;
    const third = sem.acquireShare(1, { lane: "background" }).then((s) => {
      resolved = true;
      return s;
    });
    await sleep(150);
    expect(resolved).toBe(false); // never encroaches on the reserved floor

    // Releasing a background slot wakes it; it lands back in the window, never above.
    await h1.release();
    const outcome = await Promise.race([
      third,
      sleep(2000).then(() => "TIMEOUT" as const),
    ]);
    expect(outcome).not.toBe("TIMEOUT");
    const share = outcome as HostShare;
    expect(share.slots).toBe(1);
    expect(isSlotHeld(slotsDir, 2)).toBe(false);
    expect(isSlotHeld(slotsDir, 3)).toBe(false);

    await share.release();
    await h2.release();
  });

  test("an interactive acquire is granted immediately from the floor while background is saturated", async () => {
    const slots = uniqueSlots("floor-fast");
    const slotsDir = slots.path;
    const sem = createHostSemaphore({ slots, size: 4, backgroundLimit: 2 });

    const h1 = await sem.acquireShare(1, { lane: "background" });
    const h2 = await sem.acquireShare(1, { lane: "background" });
    expect(h1.slots + h2.slots).toBe(2); // background window full

    // Spy on Bun.spawn: the interactive acquire must take the fast path — the reserved
    // floor is free, so no turnstile, no fan-out child, no blocking wait.
    const origSpawn = Bun.spawn;
    let spawnCount = 0;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      ...args: unknown[]
    ) => {
      spawnCount++;
      return (origSpawn as (...a: unknown[]) => unknown)(...args);
    }) as typeof Bun.spawn;

    try {
      let waitMs = -1;
      const share = await sem.acquireShare(1, {
        lane: "interactive",
        onAcquired: (ms) => {
          waitMs = ms;
        },
      });
      expect(share.slots).toBe(1);
      expect(spawnCount).toBe(0); // no broker: pure fast path from the floor
      expect(waitMs).toBeLessThan(50); // ~0, never blocked
      expect(isSlotHeld(slotsDir, 3)).toBe(true); // took the top of the reserved floor
      await share.release();
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }

    await h1.release();
    await h2.release();
  });

  test("interactive sweeps high-first: an idle acquire holds the top slot", async () => {
    const slots = uniqueSlots("hi-first");
    const slotsDir = slots.path;
    const sem = createHostSemaphore({ slots, size: 4, backgroundLimit: 2 });

    const share = await sem.acquireShare(1, { lane: "interactive" });
    expect(share.slots).toBe(1);
    // High-index-first: slot-(size-1) is taken, the low slots left for background.
    expect(isSlotHeld(slotsDir, 3)).toBe(true);
    expect(isSlotHeld(slotsDir, 2)).toBe(false);
    expect(isSlotHeld(slotsDir, 1)).toBe(false);
    expect(isSlotHeld(slotsDir, 0)).toBe(false);
    await share.release();
  });

  test("backgroundLimit is part of pool identity: a live split is adopted, an idle one resizes", async () => {
    const slots = uniqueSlots("bg-identity");
    const slotsDir = slots.path;

    // Establish the pool at size 4 / backgroundLimit 2 and HOLD both background slots
    // so the window is FULL and the pool is live.
    const sem = createHostSemaphore({ slots, size: 4, backgroundLimit: 2 });
    const held = await sem.acquireShare(2, { lane: "background" });
    expect(held.slots).toBe(2);

    // Same size, DIFFERENT split on the same live pool. Carving the floor at the
    // declared index-3 would let this background acquire take slot-2 — a slot the live
    // pool reserves for interactive. Adopting the live 4:2 keeps the floor where every
    // holder thinks it is, so the acquire blocks on the full window instead.
    const other = createHostSemaphore({ slots, size: 4, backgroundLimit: 3 });
    let resolved = false;
    const blocked = other.acquireShare(1, { lane: "background" }).then((s) => {
      resolved = true;
      return s;
    });
    await Bun.sleep(300);
    expect(resolved).toBe(false);
    expect(other.liveSize()).toBe(4);
    expect(isSlotHeld(slotsDir, 2)).toBe(false); // reserved floor, never encroached

    // Once a background slot frees, the adopted window grants from slot-0..1.
    await held.release();
    const share = await blocked;
    expect(share.slots).toBe(1);
    await share.release();

    // Fully idle, a fresh pool with a different split claims the sentinel silently —
    // the declared split still lands, it just waits for the pool rather than crashing.
    const resized = createHostSemaphore({ slots, size: 4, backgroundLimit: 3 });
    const third = await resized.acquireShare(3, { lane: "background" });
    expect(third.slots).toBe(3);
    await third.release();
  });
});

/** Read `stream` until the literal `"granted\n"` token; throw if it closes first. */
async function awaitGrantedRaw(
  stream: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (buf.includes("granted\n")) return;
      if (done) throw new Error("flock-wait child exited before granting");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read the first newline-terminated JSON line from `stream`. */
async function readJsonLine<T>(stream: ReadableStream<Uint8Array>): Promise<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      const nl = buf.indexOf("\n");
      if (nl >= 0) return JSON.parse(buf.slice(0, nl)) as T;
      if (done)
        throw new Error("stream closed before a JSON line was produced");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Spawn `flock-wait.ts` directly against one absolute lock file (a raw holder). */
function spawnHolder(lockFile: string) {
  return Bun.spawn([process.execPath, FLOCK_WAIT_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, FLOCK_WAIT_FILE: lockFile },
  });
}

/** True iff `pid` is still alive (signal-0 probe); ESRCH ⇒ gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

// The stranding gate. `acquireShare(1)` takes exactly the first free slot in file
// order, so four handles deterministically hold slot-0…3. A fifth waiter finds every
// slot busy and fans out. Releasing ANY one held slot must wake it — the whole point
// of the fan-out. The old pid-hashed broker parked on one slot, so at least 3 of the
// 4 releases hung; parameterizing k proves every slot wakes the waiter.
describe("wakes on any freed slot (stranding gate)", () => {
  for (const k of [0, 1, 2, 3]) {
    test(`releasing held slot ${k} wakes the fan-out waiter`, async () => {
      const sem = createHostSemaphore({
        slots: uniqueSlots(`strand-${k}`),
        size: 4,
      });

      const handles: HostShare[] = [];
      for (let i = 0; i < 4; i++) handles.push(await sem.acquireShare(1));
      expect(handles.every((h) => h.slots === 1)).toBe(true); // one slot each, slot-0…3

      const waiterP = sem.acquireShare(1);
      await sleep(150); // let the waiter reach the slow path and fan out
      await handles[k]!.release();

      // Race the waiter against a 2s timeout sentinel; the old design would time out
      // for k ∉ { winnerPid % 4 }.
      const outcome = await Promise.race([
        waiterP,
        sleep(2000).then(() => "TIMEOUT" as const),
      ]);
      expect(outcome).not.toBe("TIMEOUT");
      const share = outcome as HostShare;
      expect(share.slots).toBeGreaterThanOrEqual(1);

      await share.release();
      for (let i = 0; i < 4; i++) if (i !== k) await handles[i]!.release();
    });
  }
});

test("a SIGKILLed out-of-process holder wakes a fan-out waiter", async () => {
  // flock releases on holder *death*, not just graceful close — so a SIGKILL must
  // wake the waiter. This is the case any userspace tick-file/watcher design fails.
  const slots = uniqueSlots("sigkill");
  const slotsDir = slots.path;
  mkdirSync(slotsDir, { recursive: true });

  const holder = spawnHolder(join(slotsDir, "slot-0.lock"));
  await awaitGrantedRaw(holder.stdout); // holder now owns the only slot

  const sem = createHostSemaphore({ slots, size: 1 });
  const waiterP = sem.acquireShare(1);
  await sleep(150); // waiter finds the slot busy and fans out
  holder.kill(9); // hard kill — the flock releases as the process dies
  await holder.exited;

  const outcome = await Promise.race([
    waiterP,
    sleep(2000).then(() => "TIMEOUT" as const),
  ]);
  expect(outcome).not.toBe("TIMEOUT");
  await (outcome as HostShare).release();
});

test("a fan-out child is not orphaned when its parent is SIGKILLed", async () => {
  // A child blocked on flock must still exit when its parent dies with no chance to
  // SIGTERM it — the orphan hole the old main-thread-flock broker had. The worker-
  // thread design keeps the child's main thread free to observe stdin EOF.
  const slots = uniqueSlots("orphan");
  const slotsDir = slots.path;
  mkdirSync(slotsDir, { recursive: true });
  const lockFile = join(slotsDir, "slot-0.lock");

  // Grandparent (this test) holds the slot so the fan-out child blocks indefinitely.
  const holder = spawnHolder(lockFile);
  await awaitGrantedRaw(holder.stdout);

  // Intermediate parent spawns a flock-wait child (piped stdin) and stays alive. It
  // prints the child pid so the grandparent can watch it after the parent is killed.
  const script = `
    const child = Bun.spawn([process.execPath, "--smol", process.env.FW_PATH], {
      stdin: "pipe", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, FLOCK_WAIT_FILE: process.env.FW_LOCK },
    });
    console.log(JSON.stringify({ childPid: child.pid }));
    await new Promise(() => {});
  `;
  const intermediate = Bun.spawn([process.execPath, "-e", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, FW_PATH: FLOCK_WAIT_PATH, FW_LOCK: lockFile },
  });
  const { childPid } = await readJsonLine<{ childPid: number }>(
    intermediate.stdout,
  );

  // SIGKILL the parent — nobody is left to SIGTERM the still-blocked child. Its stdin
  // (piped from the parent) hits EOF, and its main thread (free, not blocked in flock)
  // observes it and exits.
  intermediate.kill(9);
  await intermediate.exited;

  await sleep(1500);
  expect(isAlive(childPid)).toBe(false);

  void holder.stdin.end();
  holder.kill();
  await holder.exited;
});

test("losers are reaped before the extras sweep, so no undercount", async () => {
  // When a full share is released at once, all `size` fan-out children may each grab a
  // different slot. The winner keeps one; the losers are SIGKILLed and awaited so their
  // slots are back BEFORE the extras re-sweep — the waiter must reclaim more than one.
  const sem = createHostSemaphore({ slots: uniqueSlots("extras"), size: 4 });

  const holder = await sem.acquireShare(4);
  expect(holder.slots).toBe(4);

  const waiterP = sem.acquireShare(4);
  await sleep(150);
  await holder.release(); // all four slots free simultaneously

  const share = await waiterP;
  expect(share.slots).toBeGreaterThan(1); // the extras sweep ran after losers exited
  expect(share.slots).toBeLessThanOrEqual(4);
  await share.release();
});

test("size is part of pool identity: a live size is adopted, an idle one resizes", async () => {
  const slots = uniqueSlots("identity");

  // Establish the pool at size 4 and HOLD every slot so it is live AND full.
  const sem4 = createHostSemaphore({ slots, size: 4 });
  const held = await sem4.acquireShare(4);
  expect(held.slots).toBe(4);

  // A size-8 process on the same live pool must NOT sweep slot-4..7 — nobody else is
  // watching those, so it would silently double the bound. It adopts the live 4 and
  // therefore finds the pool full, exactly as a size-4 process would.
  const sem8 = createHostSemaphore({ slots, size: 8 });
  let resolved = false;
  const blocked = sem8.acquireShare(1).then((s) => {
    resolved = true;
    return s;
  });
  await Bun.sleep(300);
  expect(resolved).toBe(false);
  expect(sem8.liveSize()).toBe(4);

  // The adopted instance is a first-class member of the size-4 pool: a freed slot
  // grants it, no differently than any other holder.
  await held.release();
  const adopted = await blocked;
  expect(adopted.slots).toBe(1);
  await adopted.release();

  // Once idle, a fresh size-8 pool claims the sentinel silently and gets all 8.
  const sem8b = createHostSemaphore({ slots, size: 8 });
  const share = await sem8b.acquireShare(8);
  expect(share.slots).toBe(8);
  await share.release();
});

test("an adopted instance converges back once the pool is resized to its declared size", async () => {
  const slots = uniqueSlots("identity-converge");

  // A size-4 pool is live and full; the size-8 instance adopts 4.
  const sem4 = createHostSemaphore({ slots, size: 4 });
  const held = await sem4.acquireShare(4);
  const sem8 = createHostSemaphore({ slots, size: 8 });
  const blocked = sem8.acquireShare(1);
  await Bun.sleep(200);
  expect(sem8.liveSize()).toBe(4);
  await held.release();
  await (await blocked).release();

  // The pool is now idle, so the size-8 instance's NEXT acquire claims its declared
  // identity rather than staying stuck on the adopted one — the adoption is a
  // reconcile per acquire, not a one-time verdict on the instance.
  const share = await sem8.acquireShare(8);
  expect(sem8.liveSize()).toBe(8);
  expect(share.slots).toBe(8);
  await share.release();
});

test("a legacy bare-integer sentinel migrates to size:size instead of crashing", async () => {
  const slots = uniqueSlots("legacy-sentinel");

  // Simulate the pre-reserved-floor on-disk state: a slot dir whose `size` sentinel
  // holds a bare "4" (the historical non-laned pools have exactly this today).
  const slotsDir = slots.path;
  mkdirSync(slotsDir, { recursive: true });
  writeFileSync(join(slotsDir, "size"), "4");

  // A size-4 (backgroundLimit defaults to 4) process must read "4" as 4:4 and proceed,
  // not throw corruption. This is the hot-path migration guarantee.
  const sem = createHostSemaphore({ slots, size: 4 });
  const share = await sem.acquireShare(4);
  expect(share.slots).toBe(4);
  await share.release();
});

test("concurrent first-acquire on a fresh pool never crashes on the size-guard race", async () => {
  // Many separate processes first-touching the same fresh pool contend on the
  // `.size.lock` guard exactly while the sentinel is still absent (between flock and
  // rename). A benign flock race must NOT crash — the old code threw "concurrent size
  // initialization" for the loser. Each probe agrees on size, so every one must end
  // OK (acquire → release), never THREW. In-process concurrency won't reproduce it
  // (the promise memo dedupes); it needs separate processes racing on the flock.
  const results: string[] = [];
  for (let trial = 0; trial < 3; trial++) {
    const slots = uniqueSlots(`race-${trial}`);
    const children = Array.from({ length: 12 }, () =>
      Bun.spawn([process.execPath, "-e", FIRST_ACQUIRE_FIXTURE], {
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          HS_MOD: HOST_SEMAPHORE_MODULE,
          HS_PATHS_MOD: PATHS_CORE_MODULE,
          HS_NAME: slots.spec.name,
        },
      }),
    );
    const outs = await Promise.all(
      children.map(async (c) => (await new Response(c.stdout).text()).trim()),
    );
    await Promise.all(children.map((c) => c.exited));
    results.push(...outs);
  }

  const threw = results.filter((r) => r.startsWith("THREW"));
  expect(threw).toEqual([]); // no process crashed on the guard race
  expect(results.every((r) => r === "OK")).toBe(true); // every one acquired
}, 30_000);

// Cancellation (`AcquireHooks.signal`). Two independent effects, tested apart
// because they answer different questions: whether a caller that is still WAITING
// can be made to stop, and whether a caller that is already HOLDING can be made to
// let go while its body runs on. The second is the one that turns "we gave up on
// this handler" into a flock every other process on the box gets back.
describe("cancellation (AcquireHooks.signal)", () => {
  test("an already-aborted signal throws before any wait or spawn", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("abort-pre"),
      size: 1,
    });
    const reason = new Error("already over budget");

    const origSpawn = Bun.spawn;
    let spawnCount = 0;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      ...args: unknown[]
    ) => {
      spawnCount++;
      return (origSpawn as (...a: unknown[]) => unknown)(...args);
    }) as typeof Bun.spawn;

    try {
      const err = await rejection(
        sem.acquireShare(1, { signal: AbortSignal.abort(reason) }),
      );
      // `signal.reason` itself, unwrapped — the standard AbortSignal contract, so
      // whoever aborted can attach context that surfaces at the wedge site.
      expect(err).toBe(reason);
      expect(spawnCount).toBe(0);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }

    // And it took nothing: the pool is fully available to the next caller.
    const share = await sem.acquireShare(1);
    expect(share.slots).toBe(1);
    await share.release();
  });

  test("a pending acquire aborts, throws signal.reason, and leaves no child alive", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("abort-pending"),
      size: 2,
    });
    // Fill the pool so the next acquire is forced onto the slow path (turnstile +
    // fan-out children) — the only place there is anything to cancel.
    const holder = await sem.acquireShare(2);
    expect(holder.slots).toBe(2);

    const spawned: { exited: Promise<number> }[] = [];
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      ...args: unknown[]
    ) => {
      const child = (origSpawn as (...a: unknown[]) => unknown)(...args) as {
        exited: Promise<number>;
      };
      spawned.push(child);
      return child;
    }) as typeof Bun.spawn;

    const ac = new AbortController();
    const reason = new Error("deadline exceeded");
    try {
      const pending = sem.acquireShare(1, { signal: ac.signal });
      await sleep(200); // reach the slow path and fan out
      expect(sem.depth()).toBe(1);
      expect(spawned.length).toBeGreaterThan(0);

      ac.abort(reason);
      expect(await rejection(pending)).toBe(reason);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }

    expect(sem.depth()).toBe(0); // the queue-depth gauge is not left inflated

    // Every child spawned for the cancelled acquire is reaped. A leaked
    // `flock-wait` child would be worse than the wedge we are cancelling: it holds
    // a slot the pool can no longer account for, for the life of the box.
    for (const child of spawned) {
      const outcome = await Promise.race([
        child.exited,
        sleep(2000).then(() => "TIMEOUT" as const),
      ]);
      expect(outcome).not.toBe("TIMEOUT");
    }

    // The pool itself is undamaged — every slot comes back.
    await holder.release();
    const after = await sem.acquireShare(2);
    expect(after.slots).toBe(2);
    await after.release();
  });

  test("cancelling the head waiter releases the turnstile, so another waiter still wakes", async () => {
    const sem = createHostSemaphore({
      slots: uniqueSlots("abort-turnstile"),
      size: 1,
    });
    const holder = await sem.acquireShare(1);

    const ac = new AbortController();
    const first = sem.acquireShare(1, { signal: ac.signal });
    await sleep(150); // head waiter: holds the turnstile, has fanned out
    const second = sem.acquireShare(1);
    await sleep(150); // queued behind the turnstile
    expect(sem.depth()).toBe(2);

    const reason = new Error("head gave up");
    ac.abort(reason);
    expect(await rejection(first)).toBe(reason);

    // The cancelled head must not take the turnstile to the grave with it —
    // otherwise one aborted waiter would strand every waiter behind it, which is
    // the wedge this whole change exists to remove rather than relocate.
    await holder.release();
    const outcome = await Promise.race([
      second,
      sleep(3000).then(() => "TIMEOUT" as const),
    ]);
    expect(outcome).not.toBe("TIMEOUT");
    await (outcome as HostShare).release();
  });

  test("a waiter queued on the TURNSTILE child aborts cleanly and reaps it", async () => {
    // The other slow-path wait: not the fan-out, but the single `flock-wait` child
    // a non-head waiter uses to queue for the turnstile. It unwinds through a
    // different branch, so it gets its own test — the head-waiter test above never
    // reaches it (the head takes the turnstile in-process, with no child at all).
    const sem = createHostSemaphore({
      slots: uniqueSlots("abort-turnstile-child"),
      size: 1,
    });
    const holder = await sem.acquireShare(1);

    const head = sem.acquireShare(1); // takes the turnstile, fans out
    await sleep(150);

    const spawned: { exited: Promise<number> }[] = [];
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      ...args: unknown[]
    ) => {
      const child = (origSpawn as (...a: unknown[]) => unknown)(...args) as {
        exited: Promise<number>;
      };
      spawned.push(child);
      return child;
    }) as typeof Bun.spawn;

    const ac = new AbortController();
    const reason = new Error("queued waiter gave up");
    try {
      const queued = sem.acquireShare(1, { signal: ac.signal });
      await sleep(200); // parked on the turnstile child, behind the head
      expect(spawned.length).toBe(1); // exactly one child: the turnstile waiter

      ac.abort(reason);
      expect(await rejection(queued)).toBe(reason);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }

    for (const child of spawned) {
      const outcome = await Promise.race([
        child.exited,
        sleep(2000).then(() => "TIMEOUT" as const),
      ]);
      expect(outcome).not.toBe("TIMEOUT");
    }

    // The head is untouched by its neighbour's cancellation.
    await holder.release();
    const share = await Promise.race([
      head,
      sleep(3000).then(() => "TIMEOUT" as const),
    ]);
    expect(share).not.toBe("TIMEOUT");
    await (share as HostShare).release();
  });

  test("run hands the slot back when the signal aborts while fn is still running", async () => {
    const slots = uniqueSlots("abort-midrun");
    const slotsDir = slots.path;
    const sem = createHostSemaphore({ slots, size: 1 });

    const ac = new AbortController();
    let settle!: () => void;
    const bodyDone = new Promise<void>((r) => {
      settle = r;
    });
    let bodyFinished = false;

    // A body that deliberately IGNORES its signal — the wedged-handler case, which
    // is the only one where any of this matters.
    const running = sem.run(
      async () => {
        await bodyDone;
        bodyFinished = true;
        return "done";
      },
      { signal: ac.signal },
    );

    await sleep(50);
    expect(isSlotHeld(slotsDir, 0)).toBe(true);

    ac.abort(new Error("deadline exceeded"));
    await sleep(50);

    // The whole point: the host slot is back WHILE the body is still running.
    expect(bodyFinished).toBe(false);
    expect(isSlotHeld(slotsDir, 0)).toBe(false);

    // ...and really usable again — a fresh acquire takes the fast path.
    const other = await sem.acquireShare(1);
    expect(other.slots).toBe(1);
    await other.release();

    // `run` does not cancel `fn` (it cannot un-await a promise), so a body that
    // finishes anyway keeps its result; the `finally` release is then a no-op
    // rather than a double-close.
    settle();
    expect(await running).toBe("done");

    const again = await sem.acquireShare(1);
    expect(again.slots).toBe(1);
    await again.release();
  });
});

describe("priority (AcquireHooks.priority)", () => {
  test("a waiting normal acquire is served before a low one queued earlier", async () => {
    const slots = uniqueSlots("prio-order");
    const sem = createHostSemaphore({ slots, size: 1 });
    const holder = await sem.acquireShare(1);

    const order: string[] = [];
    // The low acquire queues FIRST — it would win the freed slot on arrival order.
    const low = sem.acquireShare(1, { priority: "low" }).then((s) => {
      order.push("low");
      return s;
    });
    await sleep(150);
    const normal = sem.acquireShare(1).then((s) => {
      order.push("normal");
      return s;
    });
    await sleep(300);
    expect(order).toEqual([]);

    await holder.release();
    const n = await normal;
    expect(order).toEqual(["normal"]);
    // The low acquire still waits: the slot is held by the normal one.
    await sleep(150);
    expect(order).toEqual(["normal"]);

    await n.release();
    const l = await low;
    expect(order).toEqual(["normal", "low"]);
    await l.release();
  });

  test("a low acquire on an idle pool takes the fast path", async () => {
    const slots = uniqueSlots("prio-idle");
    const sem = createHostSemaphore({ slots, size: 2 });
    let waited = false;
    const share = await sem.acquireShare(2, {
      priority: "low",
      onWaitStart: () => {
        waited = true;
      },
    });
    expect(share.slots).toBe(2);
    expect(waited).toBe(false);
    await share.release();
  });

  test("a low acquire does not take a freed slot while a normal acquire is waiting", async () => {
    const slots = uniqueSlots("prio-gate");
    const sem = createHostSemaphore({ slots, size: 2 });
    const a = await sem.acquireShare(1);
    const b = await sem.acquireShare(1);

    const normal = sem.acquireShare(1);
    await sleep(300); // the normal acquire is now on the slow path, holding demand

    let lowGot = false;
    const low = sem.acquireShare(1, { priority: "low" }).then((s) => {
      lowGot = true;
      return s;
    });
    await sleep(150);

    await a.release();
    const n = await normal;
    await sleep(150);
    expect(lowGot).toBe(false); // every slot is held again (b + normal)

    await b.release();
    const l = await low;
    expect(lowGot).toBe(true);
    await l.release();
    await n.release();
  });

  test("a cancelled low acquire waiting on demand throws the reason", async () => {
    const slots = uniqueSlots("prio-abort");
    const sem = createHostSemaphore({ slots, size: 1 });
    const holder = await sem.acquireShare(1);
    const normal = sem.acquireShare(1);
    await sleep(300);

    const ac = new AbortController();
    const low = sem.acquireShare(1, { priority: "low", signal: ac.signal });
    await sleep(150);
    ac.abort(new Error("gave up"));
    expect((await rejection(low)).message).toBe("gave up");

    await holder.release();
    await (await normal).release();
  });
});
