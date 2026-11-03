// A bounded pool of worker threads that each answer one request at a time —
// for CPU-bound JS a host process would otherwise run on its ONE thread (a
// build's artifact compiles: Babel and the React Compiler are JS, and every
// "concurrent" vite run of one process shares that thread).
//
// The calling half, `createThreadPool({ url, size })`, starts workers lazily
// (none until the first request, at most `size`), hands each queued request to
// the next idle worker, and keeps a worker for its whole life so its JIT stays
// warm across requests (a cold worker pays seconds of warm-up). The worker
// half, `serveThreadPool(handle)`, is the module at `url`.
//
// Failure is loud and contained: a handler that throws rejects that request
// with the worker's message and stack; a worker that dies (an uncaught error,
// a non-zero exit) rejects the request it held and is replaced on the next
// one. An idle pool is `unref`-ed, so it never keeps its process alive;
// `close()` terminates every worker.

import { Worker, isMainThread, parentPort } from "node:worker_threads";

export interface ThreadPool<Req, Rep> {
  run(request: Req): Promise<Rep>;
  /** Terminate every worker; requests still queued reject. */
  close(): Promise<void>;
}

type Envelope<T> = { id: number; payload: T };
type Reply<Rep> =
  | { id: number; ok: true; value: Rep }
  | { id: number; ok: false; message: string; stack: string | undefined };

interface Slot {
  worker: Worker;
  busy: {
    id: number;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  } | null;
}

export function createThreadPool<Req, Rep>(opts: {
  /** The worker module: it calls `serveThreadPool`. */
  url: URL | string;
  /** At most this many workers alive (≥ 1). */
  size: number;
  /** Names the workers in errors. */
  name: string;
}): ThreadPool<Req, Rep> {
  if (!Number.isInteger(opts.size) || opts.size < 1) {
    throw new Error(
      `thread pool ${opts.name}: size must be a positive integer, got ${opts.size}`,
    );
  }
  const slots: Slot[] = [];
  const queue: Array<{
    id: number;
    request: Req;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }> = [];
  let nextId = 0;
  let closed = false;

  const spawn = (): Slot => {
    const slot: Slot = { worker: new Worker(opts.url), busy: null };
    slot.worker.on("message", (reply: Reply<Rep>) => {
      const busy = slot.busy;
      if (!busy || busy.id !== reply.id) {
        throw new Error(
          `thread pool ${opts.name}: reply ${reply.id} matches no request`,
        );
      }
      slot.busy = null;
      if (reply.ok) busy.resolve(reply.value);
      else {
        const err = new Error(reply.message);
        if (reply.stack) err.stack = reply.stack;
        busy.reject(err);
      }
      pump();
    });
    const die = (err: Error) => {
      const i = slots.indexOf(slot);
      if (i >= 0) slots.splice(i, 1);
      slot.busy?.reject(err);
      slot.busy = null;
      pump();
    };
    slot.worker.on("error", (err: unknown) =>
      die(
        new Error(
          `thread pool ${opts.name}: worker crashed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      ),
    );
    slot.worker.on("exit", (code) => {
      if (slots.includes(slot))
        die(
          new Error(
            `thread pool ${opts.name}: worker exited with code ${code}`,
          ),
        );
    });
    slots.push(slot);
    return slot;
  };

  const pump = () => {
    while (queue.length > 0) {
      let slot = slots.find((s) => s.busy === null);
      if (!slot && slots.length < opts.size) slot = spawn();
      if (!slot) break;
      const job = queue.shift()!;
      slot.busy = { id: job.id, resolve: job.resolve, reject: job.reject };
      slot.worker.ref();
      slot.worker.postMessage({
        id: job.id,
        payload: job.request,
      } satisfies Envelope<Req>);
    }
    for (const s of slots) if (s.busy === null) s.worker.unref();
  };

  return {
    run(request) {
      if (closed)
        return Promise.reject(new Error(`thread pool ${opts.name} is closed`));
      return new Promise<Rep>((resolve, reject) => {
        queue.push({
          id: nextId++,
          request,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        pump();
      });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0))
        job.reject(new Error(`thread pool ${opts.name} closed`));
      const all = slots.splice(0);
      for (const s of all)
        s.busy?.reject(new Error(`thread pool ${opts.name} closed`));
      await Promise.all(all.map((s) => s.worker.terminate()));
    },
  };
}

/**
 * The worker half: answer each request with `handle`'s result, one at a time
 * (the pool sends a worker its next request only once it replied).
 */
export function serveThreadPool<Req, Rep>(
  handle: (request: Req) => Promise<Rep>,
): void {
  if (isMainThread || !parentPort) {
    throw new Error(
      "serveThreadPool must run inside a worker thread started by createThreadPool",
    );
  }
  const port = parentPort;
  port.on("message", (envelope: Envelope<Req>) => {
    handle(envelope.payload).then(
      (value) =>
        port.postMessage({
          id: envelope.id,
          ok: true,
          value,
        } satisfies Reply<Rep>),
      (err: unknown) =>
        port.postMessage({
          id: envelope.id,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        } satisfies Reply<Rep>),
    );
  });
}
