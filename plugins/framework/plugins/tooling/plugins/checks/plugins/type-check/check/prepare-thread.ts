// The check runner's side of type-check's preparation thread.
//
// `./prepare` is 70–130 s of synchronous work, and the runner's thread is
// shared by every check in the pass — so it runs on a Bun Worker thread
// instead (`./prepare-worker`), and this module is all the runner holds: a
// request/reply channel to it. One thread per `run()`, holding one session in
// two phases (prepare → the runner fans out the tsc workers → finalize); see
// `./prepare` for why the session must survive between them.
//
// A Worker thread rather than a helper process, because the session carries
// `ProgramKeyContext.contentHash` across the fan-out, and a thread holds it in
// memory for free where a process would have to serialize it. Checks only
// ever run from source, so the worker is spawned by path the same way the
// tsc worker is (the sentinel's compiled-release vendoring does not
// apply here).
//
// Nothing here imports `./prepare` at runtime — only its types — so the
// runner's thread never evaluates the TypeScript compiler for it.

import type { Finalized, Plan, PrepareInput, ProgramOutcome } from "./prepare";

/** Runner → thread. One in flight at a time. */
export type PrepareRequest =
  | { type: "prepare"; input: PrepareInput }
  | { type: "finalize"; outcome: ProgramOutcome | undefined };

/** Thread → runner: one reply per request. */
export type PrepareReply =
  | { type: "plan"; plan: Plan }
  | { type: "finalized"; finalized: Finalized }
  /** The request threw on the thread; `stack` is the thread's own. */
  | { type: "error"; message: string; stack: string | undefined };

export interface PrepareThread {
  /** Run the prepare phase on the thread; the session stays there. */
  prepare(input: PrepareInput): Promise<Plan>;
  /**
   * Run the record phase of the session `prepare` opened, and hand back the
   * lint line and verdict. `undefined` when the worker crashed.
   */
  finalize(outcome: ProgramOutcome | undefined): Promise<Finalized>;
  /** Terminate the thread. Idempotent; a call still pending is rejected. */
  close(): void;
}

const WORKER_URL = new URL("./prepare-worker.ts", import.meta.url);

interface Pending {
  request: PrepareRequest["type"];
  resolve(reply: Exclude<PrepareReply, { type: "error" }>): void;
  reject(err: Error): void;
}

/**
 * Start the thread. The caller owns it and must `close()` it — in a `finally`,
 * since an idle worker (the minutes between `prepare` and `finalize`, while tsc
 * runs) keeps its message listener, and with it the process, alive.
 */
export function openPrepareThread(): PrepareThread {
  // The environment AS IT IS NOW, explicitly: a Bun Worker otherwise sees only
  // the environment the process STARTED with, never a later `process.env`
  // edit. The thread is this run's own code moved off the runner's thread, so
  // it must resolve every data dir (`SINGULARITY_DIR`) exactly as the runner
  // would — measured: without this, a test's redirect never reached the
  // thread, which read and copied from the host's real warm-base pool.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  const worker = new Worker(WORKER_URL, { env });
  let pending: Pending | null = null;
  // Set once the thread is gone for any reason. Every later call rejects with
  // it at once, instead of posting to a thread nobody will answer from.
  let dead: Error | null = null;

  // A failure can arrive through several doors for one cause — an `error`
  // event followed by `close`, say — so the pending call is taken exactly once
  // and a second door finds nothing to settle.
  const take = (): Pending | null => {
    const p = pending;
    pending = null;
    return p;
  };

  const die = (err: Error): void => {
    dead ??= err;
    take()?.reject(err);
  };

  worker.onmessage = (event: MessageEvent) => {
    const reply = event.data as PrepareReply;
    const p = take();
    if (!p) {
      die(
        new Error(
          `type-check prepare thread sent a "${reply.type}" reply with no request in flight`,
        ),
      );
      return;
    }
    if (reply.type === "error") {
      // The thread's own stack, not this handler's: the frames that matter
      // are the ones inside `./prepare`.
      const err = new Error(reply.message);
      if (reply.stack !== undefined) err.stack = reply.stack;
      p.reject(err);
      return;
    }
    p.resolve(reply);
  };
  // An exception outside any request (the module graph failed to evaluate, a
  // throw from a stray callback) — the thread cannot be trusted after it.
  worker.addEventListener("error", (event: ErrorEvent) => {
    die(
      new Error(`type-check prepare thread crashed: ${event.message}`, {
        cause: event.error,
      }),
    );
  });
  // Bun fires `close` whenever the worker exits. After `close()` below that is
  // expected, and `dead` is already set, so there is nothing left to reject.
  worker.addEventListener("close", () => {
    die(new Error("type-check prepare thread exited unexpectedly"));
  });

  const send = (
    message: PrepareRequest,
  ): Promise<Exclude<PrepareReply, { type: "error" }>> => {
    if (dead) return Promise.reject(dead);
    if (pending) {
      return Promise.reject(
        new Error(
          `type-check prepare thread: "${message.type}" sent while "${pending.request}" is still in flight`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      pending = { request: message.type, resolve, reject };
      worker.postMessage(message);
    });
  };

  return {
    async prepare(input) {
      const reply = await send({ type: "prepare", input });
      if (reply.type !== "plan") {
        throw new Error(
          `type-check prepare thread answered "prepare" with "${reply.type}"`,
        );
      }
      return reply.plan;
    },
    async finalize(outcome) {
      const reply = await send({ type: "finalize", outcome });
      if (reply.type !== "finalized") {
        throw new Error(
          `type-check prepare thread answered "finalize" with "${reply.type}"`,
        );
      }
      return reply.finalized;
    },
    close() {
      die(new Error("type-check prepare thread was closed"));
      worker.terminate();
    },
  };
}
