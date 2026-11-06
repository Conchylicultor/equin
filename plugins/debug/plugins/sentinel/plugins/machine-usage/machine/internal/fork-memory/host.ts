import { pathToFileURL } from "node:url";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  defineDaemon,
  type WorkerDaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import type { ForkTree } from "./fork-tree-meter";
import type { MainToWorkerFrame, WorkerToMainFrame } from "./protocol";

// The backend's half of the fork-memory worker (`./entry.ts`): started on the
// first reading that needs it, kept for the backend's life (its change cache
// is what keeps a reading near O(what changed)), asked one request per
// reading. A worker that dies fails every request it held, loudly; the next
// spawn starts with an empty cache.

export const forkMemoryDaemon = defineDaemon({
  name: "machine-usage.fork-memory",
  description:
    "Walks the Postgres cluster's memory map on a worker thread, so the machine-usage readings count the cluster's shared segment once instead of once per backend — the kernel walk is seconds of synchronous calls a backend's event loop must not run.",
  startedBy: "on-demand",
  where: "every-worktree",
  restart: { kind: "backoff", healthy: "survival" },
});

interface Pending {
  resolve: (bytes: Map<number, number>) => void;
  reject: (err: Error) => void;
}

let instance: WorkerDaemonInstance | null = null;
const pending = new Map<number, Pending>();
let nextId = 0;

/**
 * Dev runs the entry from source. A compiled release cannot embed a
 * `new Worker(new URL(...))` entry, so it vendors the worker as a bundled
 * `.js` and the launcher points `EQUIN_FORK_MEMORY_WORKER_JS` at it (the
 * sentinel worker's pattern).
 */
function workerUrl(): URL {
  const vendored = readEnv("FORK_MEMORY_WORKER_JS");
  return vendored
    ? pathToFileURL(vendored)
    : new URL("./entry.ts", import.meta.url);
}

function failAll(reason: string): void {
  for (const p of pending.values()) {
    p.reject(new Error(`[machine-usage] fork-memory worker: ${reason}`));
  }
  pending.clear();
}

function ensureWorker(): WorkerDaemonInstance {
  instance ??= forkMemoryDaemon.spawnWorker({
    url: workerUrl(),
    onMessage: (data) => {
      const frame = data as WorkerToMainFrame;
      const p = pending.get(frame.id);
      if (p === undefined) return;
      pending.delete(frame.id);
      if (frame.type === "measured") p.resolve(new Map(frame.bytes));
      else p.reject(new Error(frame.error));
    },
    onState: (t) => {
      if (t.state === "respawning" || t.state === "gave-up") {
        failAll(`died (${t.lastError ?? "no error"})`);
      }
      if (t.state === "gave-up" || t.state === "stopped") instance = null;
    },
  });
  return instance;
}

/**
 * Each fork-tree process's memory, bytes, with the tree's shared memory
 * charged once to its root; a process gone before it was read is absent.
 */
export function measureForkTrees(
  trees: ForkTree[],
): Promise<Map<number, number>> {
  if (trees.length === 0) return Promise.resolve(new Map());
  const worker = ensureWorker();
  // Between incarnations postMessage drops the frame: fail now, not never.
  if (worker.state !== "running") {
    return Promise.reject(
      new Error("[machine-usage] fork-memory worker: respawning after a death"),
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const frame: MainToWorkerFrame = { type: "measure", id, trees };
    worker.postMessage(frame);
  });
}

export async function stopForkMemoryWorker(): Promise<void> {
  const running = instance;
  instance = null;
  failAll("stopped");
  await running?.stop();
}
