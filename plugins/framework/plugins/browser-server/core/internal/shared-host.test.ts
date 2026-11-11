/**
 * A SharedWorker host's end of life, over real MessageChannels and a Web
 * Locks stand-in with the spec's queueing (FIFO; `ifAvailable`; `signal`):
 * the host retires once its last page left and its last request was
 * answered; a page that connects while it retires moves to the next name,
 * never to the closing worker; a page that connected first keeps it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserServer } from "./browser-server";
import {
  portBrowserServer,
  serveHost,
  type PortServer,
  type ServedHost,
} from "./port";
import {
  connectSharedHost,
  retireLockName,
  type SharedHostConnection,
} from "./shared-host";

// ── Web Locks, as much as the protocol uses ─────────────────────────────────

type Mode = "exclusive" | "shared";
interface Pending {
  mode: Mode;
  grant: () => void;
}
interface Held {
  mode: Mode;
}
const lockState = new Map<string, { held: Set<Held>; queue: Pending[] }>();
const stateOf = (name: string) => {
  let s = lockState.get(name);
  if (s === undefined)
    lockState.set(name, (s = { held: new Set(), queue: [] }));
  return s;
};
const fits = (mode: Mode, held: Set<Held>): boolean =>
  mode === "exclusive"
    ? held.size === 0
    : [...held].every((h) => h.mode === "shared");
function grantQueued(name: string): void {
  const s = stateOf(name);
  while (s.queue.length > 0 && fits(s.queue[0]!.mode, s.held))
    s.queue.shift()!.grant();
}
const locks = {
  request<T>(
    name: string,
    options: { mode?: Mode; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => T | Promise<T>,
  ): Promise<T> {
    const mode = options.mode ?? "exclusive";
    const s = stateOf(name);
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        const held: Held = { mode };
        s.held.add(held);
        void Promise.resolve()
          .then(() => callback({ name }))
          .then(resolve, reject)
          .finally(() => {
            s.held.delete(held);
            grantQueued(name);
          });
      };
      if (options.ifAvailable === true) {
        if (s.queue.length === 0 && fits(mode, s.held)) run();
        else void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const pending: Pending = { mode, grant: run };
      s.queue.push(pending);
      options.signal?.addEventListener("abort", () => {
        const at = s.queue.indexOf(pending);
        if (at < 0) return;
        s.queue.splice(at, 1);
        reject(new DOMException("aborted", "AbortError"));
        grantQueued(name);
      });
      grantQueued(name);
    });
  },
};

let hadLocks: PropertyDescriptor | undefined;
beforeAll(() => {
  hadLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    value: locks,
    configurable: true,
  });
});
afterAll(() => {
  if (hadLocks === undefined) Reflect.deleteProperty(navigator, "locks");
  else Object.defineProperty(navigator, "locks", hadLocks);
});

// ── SharedWorkers, by name ──────────────────────────────────────────────────

/** A request the test answers when it says so. */
function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

interface FakeWorker {
  name: string;
  /** `retire.run` began: the storage is closing. */
  retiring: boolean;
  /** Held until the test lets the worker finish closing. */
  closing: ReturnType<typeof gate>;
  /** What its server's requests wait on. */
  answering: ReturnType<typeof gate>;
  serve: (end: MessagePort) => void;
  served: ServedHost;
}

let run = 0;
/** One browser's SharedWorkers, by name; `base` is this test's own name (`h<n>`): locks are page-wide. */
function sharedWorkers() {
  const base = `h${run++}`;
  const live = new Map<string, FakeWorker>();
  const started: string[] = [];
  const open = (name: string): SharedWorker => {
    let worker = live.get(name);
    if (worker === undefined) {
      started.push(name);
      const w: Omit<FakeWorker, "served"> & { served?: ServedHost } = {
        name,
        retiring: false,
        closing: gate(),
        answering: gate(),
        serve: () => {
          throw new Error("not accepting yet");
        },
      };
      w.answering.open();
      const server: BrowserServer = {
        id: name,
        request: async () => {
          await w.answering.wait;
          return new Response("ok");
        },
        connect: () => {
          throw new Error("no sockets here");
        },
        dispose: () => {},
      };
      w.served = serveHost({
        accept: (serve) => (w.serve = serve),
        boot: () =>
          Promise.resolve({
            server,
            keys: new Set<string>(),
            boot: { plugins: 0, stages: [], slowest: [] },
          }),
        retire: {
          lock: retireLockName(name),
          async run() {
            w.retiring = true;
            await w.closing.wait;
            // Closed: a later `new SharedWorker(name)` starts a fresh one —
            // after the browser heard of it, which the lock outlasts.
            live.delete(name);
          },
        },
      });
      worker = w as FakeWorker;
      live.set(name, worker);
    }
    const channel = new MessageChannel();
    worker.serve(channel.port2);
    channel.port2.start();
    return { port: channel.port1 } as unknown as SharedWorker;
  };
  return { base, live, started, open };
}

/** Connect by generation (`h`, `h@1`, …), skipping a retiring name, and wait for `ready`. */
async function connect(
  workers: { base: string; open: (name: string) => SharedWorker },
  generation: { at: number },
): Promise<{ connection: SharedHostConnection; host: PortServer }> {
  const { base } = workers;
  const connection = await connectSharedHost({
    open: workers.open,
    name: () => (generation.at === 0 ? base : `${base}@${generation.at}`),
    passed: () => (generation.at += 1),
  });
  const serving = portBrowserServer(connection.port);
  connection.port.start();
  return { connection, host: await serving };
}

/** Let queued messages, lock grants and timers run until `ok()` holds. */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`never: ${what}`);
}
/** Let everything already queued run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a SharedWorker host's end of life", () => {
  test("retires once its last page leaves", async () => {
    const workers = sharedWorkers();
    const a = await connect(workers, { at: 0 });
    const worker = workers.live.get(workers.base)!;
    await settle();
    expect(worker.retiring).toBe(false);
    a.connection.leave();
    await until(() => worker.retiring, "the host retires");
    worker.closing.open();
    await until(() => !workers.live.has(workers.base), "the worker closes");
  });

  test("a page that connects while it retires goes to the next name, never to the closing worker", async () => {
    const workers = sharedWorkers();
    const generation = { at: 0 };
    const a = await connect(workers, generation);
    const old = workers.live.get(workers.base)!;
    a.connection.leave();
    await until(() => old.retiring, "the host retires");
    // Still matchable by its name while it closes: the lock keeps the page off it.
    const b = await connect(workers, generation);
    expect(b.connection.name).toBe(`${workers.base}@1`);
    expect(workers.started).toEqual([workers.base, `${workers.base}@1`]);
    old.closing.open();
    b.connection.leave();
  });

  test("a page that connected first keeps it: it retires only once both left", async () => {
    const workers = sharedWorkers();
    const generation = { at: 0 };
    const a = await connect(workers, generation);
    const b = await connect(workers, generation);
    expect(b.connection.name).toBe(workers.base);
    const worker = workers.live.get(workers.base)!;
    a.connection.leave();
    await settle();
    expect(worker.retiring).toBe(false);
    b.connection.leave();
    await until(() => worker.retiring, "the host retires");
    worker.closing.open();
  });

  test("a host another worker took over goes too, once it told its pages", async () => {
    const workers = sharedWorkers();
    const a = await connect(workers, { at: 0 });
    const worker = workers.live.get(workers.base)!;
    worker.served.end("superseded");
    expect(await a.host.ended).toBe("superseded");
    await until(() => worker.retiring, "the superseded host retires");
    worker.closing.open();
    a.connection.leave();
  });

  test("a request still being answered when its page leaves is finished first", async () => {
    const workers = sharedWorkers();
    const a = await connect(workers, { at: 0 });
    const worker = workers.live.get(workers.base)!;
    worker.answering = gate();
    const asked = a.host.server.request(new Request("http://host/api/mark"));
    await settle();
    a.connection.leave();
    await settle();
    expect(worker.retiring).toBe(false);
    worker.answering.open();
    await until(() => worker.retiring, "the host retires once it answered");
    // Answered on the port the page already left: nothing reads it.
    expect(asked).toBeInstanceOf(Promise);
    worker.closing.open();
  });
});
