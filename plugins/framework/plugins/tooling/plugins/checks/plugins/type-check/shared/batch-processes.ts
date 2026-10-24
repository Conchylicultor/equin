// Batches in child processes, `width` at once (the worker runs one: see
// `./batch-run.ts`). One process per batch, started the way the
// worker itself is (a job file in, one JSON result on stdout, through the
// wedge-proof `spawnCaptured`): a process exit is the push signal that frees a
// slot, so no channel between processes is needed.
//
// A batch is served the `.d.ts` this run produced through a SPOOL directory
// (one file per hash, written before the batch that needs it is dispatched),
// and every other `.d.ts` from the host-wide store, read by the child.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { TypeCheckTree } from "../core";
import type { BatchJob, BatchOutcome, Batching } from "./batch-run";
import type { BatchProcessJob } from "./batch-worker";

const BATCH_WORKER = fileURLToPath(
  new URL("./batch-worker.ts", import.meta.url),
);

/** What a worker's batch processes cost: its share of the worker's rusage, which counts reaped children. */
export interface BatchSpend {
  count: number;
  cpuSeconds: number;
  maxRssBytes: number;
}

export function processBatches(opts: {
  k: number;
  width: number;
  root: string;
  tree: TypeCheckTree;
  /** Added to as each batch process is reaped. */
  spend: BatchSpend;
}): Batching {
  return {
    k: opts.k,
    open(ctx) {
      const spool = mkdtempSync(join(os.tmpdir(), "type-check-batches-"));
      const fixed = {
        root: opts.root,
        tree: opts.tree,
        options: ctx.options,
        spool,
        declRoots: [...ctx.declRoots],
        globals: [...ctx.globals],
        declScopes: [...ctx.declScopes],
        ambient: [...ctx.ambient],
      };
      return {
        width: opts.width,
        publish(hash, text) {
          writeFileSync(join(spool, hash), text);
        },
        async run(job: BatchJob): Promise<BatchOutcome> {
          const jobPath = join(spool, `job-${job.index}.json`);
          const full: BatchProcessJob = { ...fixed, ...job };
          writeFileSync(jobPath, JSON.stringify(full));
          const startedAt = performance.now();
          const spawned = await spawnCaptured(
            [process.execPath, BATCH_WORKER, jobPath],
            {
              cwd: opts.root,
              env: process.env,
              unbounded:
                "a batch holds up to K files of a cold type check: minutes of TS work on a loaded host, bounded by its parent worker, which owns no shorter deadline",
            },
          );
          const wallMs = performance.now() - startedAt;
          const { cpuTimeMicros, maxRssBytes } = spawned.resourceUsage;
          opts.spend.count++;
          opts.spend.cpuSeconds += (cpuTimeMicros ?? 0) / 1e6;
          opts.spend.maxRssBytes = Math.max(
            opts.spend.maxRssBytes,
            maxRssBytes ?? 0,
          );
          if (spawned.exitCode !== 0) {
            throw new Error(
              `type-check batch ${job.index} (${job.sources.length} files) exited ${spawned.exitCode}:\n${spawned.stderr.trim() || spawned.stdout.trim()}`,
            );
          }
          const outcome = JSON.parse(spawned.stdout) as BatchOutcome;
          if (outcome.kind === "contract-missing") return outcome;
          return {
            ...outcome,
            cost: { cpuMicros: cpuTimeMicros, maxRssBytes, wallMs },
          };
        },
        close() {
          rmSync(spool, { recursive: true, force: true });
        },
      };
    },
  };
}
