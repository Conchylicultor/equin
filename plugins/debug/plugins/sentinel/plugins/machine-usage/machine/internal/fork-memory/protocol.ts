import type { ForkTree } from "./fork-tree-meter";

// The frames between a backend and its fork-memory worker: one request per
// reading, answered by id (two readers — the 30 s owner sampler and an opened
// Machine watcher card — may ask at once).

export type MainToWorkerFrame = {
  type: "measure";
  id: number;
  trees: ForkTree[];
};

export type WorkerToMainFrame =
  | { type: "measured"; id: number; bytes: [pid: number, bytes: number][] }
  | { type: "failed"; id: number; error: string };
