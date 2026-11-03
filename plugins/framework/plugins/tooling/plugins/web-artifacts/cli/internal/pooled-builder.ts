// The pooled artifact builder the build CLI hands the pipeline: stale
// artifacts compile on `threads` worker threads (`bin/build-worker.ts`), each
// building one at a time, instead of all sharing this process's one JS thread.
//
// Sizing, measured on the quiet 6-core VM (2026-11-02, a whole cold
// frontend, 1,937 artifacts): in-process 33.2 s; 2 threads 24.2 s, 3 21.2 s,
// 4 18.9 s, 6 21.0 s. A build already keeps more than one core busy
// (Rolldown's native threads beside the JS), so about two threads per three
// cores saturate the machine; more only add JIT warm-up. Peak memory: 2.9 GB
// in-process, 4.1 GB with 4 threads (~0.3 GB a thread). The caller clamps the
// count to its host grant and admits the pipeline for that many units — each
// thread is a CPU-heavy worker, which is what a unit bounds.

import os from "node:os";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createThreadPool } from "@plugins/packages/plugins/thread-pool/cli";
import type {
  ArtifactBuilder,
  ArtifactBuildRequest,
  ArtifactMeta,
} from "../../core";

/** About two worker threads per three cores, at least one. */
export function idealArtifactBuildThreads(): number {
  return Math.max(1, Math.round((os.availableParallelism() * 2) / 3));
}

export function createPooledArtifactBuilder(opts: {
  repoRoot: AppPath;
  minify: boolean;
  threads: number;
}): ArtifactBuilder & { close(): Promise<void> } {
  const pool = createThreadPool<ArtifactBuildRequest, ArtifactMeta>({
    url: new URL("../../bin/build-worker.ts", import.meta.url),
    size: opts.threads,
    name: "artifact-build",
  });
  return {
    build: (target) =>
      pool.run({ repoRoot: opts.repoRoot, minify: opts.minify, target }),
    close: () => pool.close(),
  };
}
