// The read-only formatting pass, on its own thread.
//
// `format-clean` and `lint-directives-stable` both format the branch's changed
// files inside a check pass, whose ~100 checks share ONE JS thread. Loading
// prettier is one long module evaluation, and prettier's parse + print of one
// file is one synchronous run — neither can be split by yielding, so either one
// alone could hold every other check (and every check's timeout) for seconds.
// So the formatting runs on a worker thread (`./format-worker`), and this module is
// all the calling thread holds: a request/reply channel to it.
//
// One worker per process, opened on first use and kept for the rest of it. It is
// `unref`-ed whenever no request is in flight, so an idle worker never keeps the
// process alive. Results are remembered by (file, content), so the two checks
// in one pass format each file once, and a changed file is never served a stale
// answer.
//
// The worker calls the SAME `formatSource` the build's writer calls in-process,
// so the options and allowlist cannot drift between the two. Nothing here
// imports `./prettier` at runtime, only its types — the calling thread never
// evaluates prettier for this.

import { Worker } from "node:worker_threads";
import { FormatSyntaxError } from "./format-error";
import type { SourceBytes } from "./prettier";

/** Calling thread → worker. */
export interface FormatRequest {
  id: number;
  sources: SourceBytes[];
}

/** Worker → calling thread: one reply per request. */
export type FormatReply =
  | { id: number; type: "formatted"; formatted: string[] }
  /**
   * `formatSource` threw on the worker; `stack` is the worker's own. `syntax`:
   * it was a {@link FormatSyntaxError}, re-created as one here.
   */
  | {
      id: number;
      type: "error";
      message: string;
      stack: string | undefined;
      syntax: boolean;
    };

const WORKER_URL = new URL("./format-worker.ts", import.meta.url);

interface Pending {
  resolve(formatted: string[]): void;
  reject(err: Error): void;
}

interface FormatThread {
  send(sources: SourceBytes[]): Promise<string[]>;
}

function openFormatThread(): FormatThread {
  const worker = new Worker(WORKER_URL);
  worker.unref();
  const pending = new Map<number, Pending>();
  let nextId = 0;
  // Set once the worker is gone for any reason. Every later call rejects with
  // it at once, instead of posting to a worker nobody will answer from.
  let dead: Error | null = null;

  const settle = (id: number): Pending | undefined => {
    const p = pending.get(id);
    pending.delete(id);
    if (pending.size === 0) worker.unref();
    return p;
  };

  const die = (err: Error): void => {
    dead ??= err;
    for (const id of [...pending.keys()]) settle(id)?.reject(err);
  };

  worker.on("message", (reply: FormatReply) => {
    const p = settle(reply.id);
    if (!p) {
      die(
        new Error(
          `format thread sent a reply to request ${reply.id}, which is not in flight`,
        ),
      );
      return;
    }
    if (reply.type === "error") {
      // The worker's own stack: the frames that matter are inside prettier.
      const err = reply.syntax
        ? new FormatSyntaxError(reply.message)
        : new Error(reply.message);
      if (reply.stack !== undefined) err.stack = reply.stack;
      p.reject(err);
      return;
    }
    p.resolve(reply.formatted);
  });
  // An exception outside any request (the module graph failed to evaluate):
  // the worker cannot be trusted after it.
  worker.on("error", (err: Error) => {
    die(new Error(`format thread crashed: ${err.message}`, { cause: err }));
  });
  worker.on("exit", (code: number) => {
    die(new Error(`format thread exited unexpectedly (code ${code})`));
  });

  return {
    send(sources) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.ref();
        const request: FormatRequest = { id, sources };
        worker.postMessage(request);
      });
    },
  };
}

let thread: FormatThread | null = null;
const results = new Map<string, Promise<string>>();

/**
 * `formatSource` for each of `sources`, computed on the format worker. Same
 * answers, same throws (a held-out path, a prettier syntax error), in order.
 * Read-only callers only: the build's writer formats in-process, where there is
 * no shared thread to protect.
 */
export async function formatOffThread(
  sources: SourceBytes[],
): Promise<string[]> {
  const keyOf = (s: SourceBytes) => `${s.file}\0${s.content}`;
  const missing = new Map<string, SourceBytes>();
  for (const s of sources) {
    if (!results.has(keyOf(s))) missing.set(keyOf(s), s);
  }
  if (missing.size > 0) {
    thread ??= openFormatThread();
    const batch = thread.send([...missing.values()]);
    [...missing.keys()].forEach((key, i) => {
      results.set(
        key,
        batch.then(
          (formatted) => formatted[i]!,
          (err: unknown) => {
            // A failed batch must not stay remembered as these bytes' answer.
            results.delete(key);
            throw err;
          },
        ),
      );
    });
  }
  return Promise.all(sources.map((s) => results.get(keyOf(s))!));
}
