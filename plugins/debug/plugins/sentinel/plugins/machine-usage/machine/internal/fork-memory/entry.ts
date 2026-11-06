import { readProcRusage } from "@plugins/packages/plugins/proc-rusage/core";
import { createForkTreeMeter } from "./fork-tree-meter";
import { readProcRegion, regionPageBytes } from "./proc-regions";
import type { MainToWorkerFrame, WorkerToMainFrame } from "./protocol";

// The fork-memory worker: walks the Postgres tree's VM regions off the
// backend's event loop (the kernel counts each region's pages synchronously —
// ~1.6 s for a whole cluster at moderate load, 4.6 s at load ~50, before the
// meter's template skip and change cache). One meter for the worker's life,
// so a backend whose footprint did not move since the last reading is not
// walked again. Lean closure: bun:ffi, the rusage binding, the pure meter.

declare const self: Worker;

const meter = createForkTreeMeter({
  readRegion: readProcRegion,
  readStamp: (pid) => {
    const r = readProcRusage(pid);
    return r.kind === "read"
      ? { startedAt: r.startedNs, footprintBytes: r.memory.physFootprintBytes }
      : null;
  },
  pageBytes: regionPageBytes(),
});

function post(frame: WorkerToMainFrame): void {
  self.postMessage(frame);
}

self.onmessage = (event: MessageEvent<MainToWorkerFrame>) => {
  const frame = event.data;
  try {
    post({
      type: "measured",
      id: frame.id,
      bytes: [...meter.measure(frame.trees)],
    });
  } catch (err) {
    // Answered, not swallowed: the request rejects with it on the backend.
    post({
      type: "failed",
      id: frame.id,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
};
