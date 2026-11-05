// The pooled record workers the build installs (`installRecordWorkers`): the
// misses of a cold record store — every plugin's facets — run on worker threads (`bin/record-worker.ts`) instead of all
// on this process's one JS thread. Same sizing rule as the artifact pool
// (about two threads per three cores, `web-artifacts`' pooled-builder): each
// thread is a CPU-heavy worker, and past that the machine is saturated and
// more threads only add JIT warm-up. The caller clamps it to its host grant.
//
// Lazy: no thread starts until a batch of misses is big enough to be split
// (`runRecordJobs`), so a warm build never pays one.

import os from "node:os";
import { createThreadPool } from "@plugins/packages/plugins/thread-pool/cli";
import type { RecordJobRequest, RecordWorkers } from "../../core";

/** About two worker threads per three cores, at least one. */
export function idealRecordWorkerThreads(): number {
  return Math.max(1, Math.round((os.availableParallelism() * 2) / 3));
}

export function createPooledRecordWorkers(opts: {
  threads: number;
}): RecordWorkers & { close(): Promise<void> } {
  const url = new URL("../../bin/record-worker.ts", import.meta.url);
  const pool = createThreadPool<RecordJobRequest, unknown>({
    url,
    size: opts.threads,
    name: "plugin-records",
  });
  return {
    size: opts.threads,
    run: (request) => pool.run(request),
    close: () => pool.close(),
  };
}
