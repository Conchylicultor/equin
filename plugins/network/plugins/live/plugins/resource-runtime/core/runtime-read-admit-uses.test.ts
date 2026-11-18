/**
 * Read admission holds a slot only around a read's own resource USES — a DB
 * statement, a file call (`usingSlot("db" | "fs")`, called by the DB driver and
 * timed-fs) — and a child process takes a slot of the separate `read-spawn`
 * gate. A read waiting on anything else (another read's flight, a mutex, a
 * worker thread's reply, a child) holds no read-admit slot, with no call site
 * to remember. Each "holds no slot" test below HANGS under the old semantics
 * (a slot held for the whole loader unless a wait opted out): six such reads
 * filled the gate and the unrelated reads never acked.
 * Run with `./equin test plugins/network/plugins/live/plugins/resource-runtime`.
 *
 * Incidents: main 2026-11-03 (131 reads waited ~12 s on one transcript), and
 * 2026-11-18 (about half of the read-admit holder time was a worker reply, a
 * CLI probe or git — 2.8–3.9 s waits).
 * research/2026-11-18-network-read-admit-use-scoped-slots.md
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { z } from "zod";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  installLeaseContextRuntime,
  usingSlot,
  type LeaseScope,
} from "@plugins/packages/plugins/semaphore/core";
import { createHarness, controllable, tick } from "./test-support";

// What `runtime-profiler/server` installs at boot.
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
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Harness = ReturnType<typeof createHarness>;

/** Unrelated reads, each one DB statement. */
function defineUnrelated(h: Harness): string[] {
  const keys = ["places", "reports", "config"];
  for (const key of keys) {
    h.runtime.defineExternalResource({
      key,
      mode: "push",
      schema: z.string(),
      loader: () => usingSlot("db", async () => key),
    });
  }
  return keys;
}

const acked = (h: Harness, key: string) =>
  h.frames.some((f) => f.kind === "sub-ack" && f.key === key);

/**
 * Six reads (distinct keys, so no key share caps them) each WAITING on `wait`
 * — never a use — then the unrelated reads: they must all ack while the six
 * still wait, and the gate must hold nothing.
 */
async function sixWaitersThenUnrelated(
  wait: (i: number) => Promise<string>,
  release: () => void,
): Promise<void> {
  const h = createHarness();
  for (let i = 0; i < 6; i++) {
    h.runtime.defineExternalResource({
      key: `waiter-${i}`,
      mode: "push",
      schema: z.string(),
      loader: () => wait(i),
    });
  }
  const unrelated = defineUnrelated(h);
  for (let i = 0; i < 6; i++) await h.subscribe(`waiter-${i}`);
  for (const key of unrelated) await h.subscribe(key);
  await tick();
  expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
  for (const key of unrelated) expect(acked(h, key)).toBe(true);
  expect(acked(h, "waiter-0")).toBe(false);
  release();
  await tick();
  await tick();
  for (let i = 0; i < 6; i++) expect(acked(h, `waiter-${i}`)).toBe(true);
  expect(h.runtime.readGateStats().active).toBe(0);
}

describe("read admission — a slot covers only a read's own DB / fs uses", () => {
  test("six reads waiting on a worker thread's reply hold no slot", async () => {
    const worker = deferred<string>();
    await sixWaitersThenUnrelated(
      () => worker.promise,
      () => worker.resolve("reply"),
    );
  });

  test("six reads waiting on a keyed mutex hold no slot", async () => {
    const mutex = createKeyedMutex();
    const holder = deferred();
    // The key's holder is busy (on anything); every read queues on the key.
    const held = mutex.run("conv", () => holder.promise);
    await sixWaitersThenUnrelated(
      () => mutex.run("conv", async () => "turn"),
      () => holder.resolve(),
    );
    await held;
  });

  test("six reads joining another read's flight hold no slot", async () => {
    const memo = createInflight("test");
    const transcript = deferred<string>();
    // The slow shared work is already running (a watcher's first read).
    const watcherRead = memo.run("transcript", () => transcript.promise);
    await sixWaitersThenUnrelated(
      () => memo.run("transcript", () => Promise.resolve("never runs")),
      () => transcript.resolve("events"),
    );
    await watcherRead;
  });

  test("six reads waiting on child processes hold no read-admit slot; their children take read-spawn slots", async () => {
    const children = deferred<string>();
    await sixWaitersThenUnrelated(
      () => usingSlot("spawn", () => children.promise),
      () => children.resolve("exited"),
    );
  });

  test("a read's DB statement holds its slot: running statements still cap at six", async () => {
    const h = createHarness();
    const ctl = controllable("v");
    // Eight keys, so no key's share (READ_KEY_SHARE) is what caps them.
    for (let k = 0; k < 8; k++) {
      h.runtime.defineExternalResource({
        key: `r${k}`,
        mode: "push",
        schema: z.string(),
        loader: () => usingSlot("db", () => ctl.loader()),
      });
    }
    ctl.block();
    for (let k = 0; k < 8; k++) await h.subscribe(`r${k}`);
    await tick();
    expect(h.runtime.readGateStats()).toMatchObject({
      active: 6,
      queued: 2,
      max: 6,
    });
    ctl.release();
    await tick();
    await tick();
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
    for (let k = 0; k < 8; k++) expect(acked(h, `r${k}`)).toBe(true);
  });

  test("the read doing the shared work holds a slot only while that work is a use; its joiners hold none", async () => {
    const h = createHarness();
    const memo = createInflight("test");
    const query = deferred<string>();
    for (let i = 0; i < 6; i++) {
      h.runtime.defineExternalResource({
        key: `derived-${i}`,
        mode: "push",
        schema: z.string(),
        // derived-0 STARTS the shared read (a DB statement) in its slot; the
        // others join it.
        loader: async () =>
          `${await memo.run("transcript", () => usingSlot("db", () => query.promise))}:${i}`,
      });
    }
    const unrelated = defineUnrelated(h);
    for (let i = 0; i < 6; i++) await h.subscribe(`derived-${i}`);
    for (const key of unrelated) await h.subscribe(key);
    await tick();
    expect(h.runtime.readGateStats().active).toBe(1);
    for (const key of unrelated) expect(acked(h, key)).toBe(true);
    query.resolve("events");
    await tick();
    await tick();
    for (let i = 0; i < 6; i++) {
      const ack = h.frames.find(
        (f) => f.kind === "sub-ack" && f.key === `derived-${i}`,
      );
      expect(ack?.value).toBe(`events:${i}`);
    }
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
  });

  test("at most six reads' children run at once, and they never block a DB read", async () => {
    const h = createHarness();
    const started: number[] = [];
    const children = Array.from({ length: 8 }, () => deferred<string>());
    for (let k = 0; k < 8; k++) {
      h.runtime.defineExternalResource({
        key: `git-${k}`,
        mode: "push",
        schema: z.string(),
        loader: () =>
          usingSlot("spawn", () => {
            started.push(k);
            return children[k]!.promise;
          }),
      });
    }
    const unrelated = defineUnrelated(h);
    for (let k = 0; k < 8; k++) await h.subscribe(`git-${k}`);
    for (const key of unrelated) await h.subscribe(key);
    await tick();
    expect(started).toHaveLength(6);
    expect(h.runtime.readSpawnGateStats()).toMatchObject({
      active: 6,
      queued: 2,
      max: 6,
    });
    expect(h.runtime.readGateStats()).toMatchObject({ active: 0, queued: 0 });
    for (const key of unrelated) expect(acked(h, key)).toBe(true);
    for (const c of children) c.resolve("out");
    await tick();
    await tick();
    expect(started).toHaveLength(8);
    expect(h.runtime.readSpawnGateStats()).toMatchObject({
      active: 0,
      queued: 0,
    });
  });

  test("one key's children take at most its share of the read-spawn gate", async () => {
    const h = createHarness();
    const started: string[] = [];
    const child = deferred<string>();
    h.runtime.defineExternalResource({
      key: "probe",
      mode: "push",
      schema: z.string(),
      loader: (params) =>
        usingSlot("spawn", () => {
          started.push(String(params.id));
          return child.promise;
        }),
    });
    for (let i = 0; i < 5; i++) await h.subscribe("probe", { id: `${i}` });
    await tick();
    expect(started).toHaveLength(3); // READ_KEY_SHARE
    child.resolve("ok");
    await tick();
    await tick();
    expect(started).toHaveLength(5);
  });
});
