// Batches in child processes, `width` at once (the worker runs one: see
// `./batch-run.ts`). One process per batch, started the way the
// worker itself is (a job file in, one JSON result on stdout, through the
// wedge-proof `spawnCaptured`): a process exit is the push signal that frees a
// slot, so no channel between processes is needed.
//
// A batch is served the `.d.ts` this run produced through a SPOOL directory
// (one file per hash, written before the batch that needs it is dispatched),
// and every other `.d.ts` from the host-wide store, read by the child.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { pacedHeapEnv } from "@plugins/packages/plugins/heap-pacing/core";
import { readEnvPath } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import type { TypeCheckTree } from "../core";
import type { BatchJob, BatchOutcome, Batching } from "./batch-run";
import type { BatchProcessJob } from "./batch-worker";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

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
  root: AppPath;
  tree: TypeCheckTree;
  /** Added to as each batch process is reaped. */
  spend: BatchSpend;
}): Batching {
  return {
    k: opts.k,
    open(ctx) {
      const spool = asAppPath(
        mkdtempSync(join(os.tmpdir(), "type-check-batches-")),
      );
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
          writeFileSync(joinAppPath(spool, hash), text);
        },
        async run(job: BatchJob): Promise<BatchOutcome> {
          const jobPath = joinAppPath(spool, `job-${job.index}.json`);
          const full: BatchProcessJob = { ...fixed, ...job };
          writeFileSync(jobPath, JSON.stringify(full));
          const startedAt = performance.now();
          const spawned = await spawnCaptured(
            [process.execPath, BATCH_WORKER, jobPath],
            {
              cwd: opts.root,
              // The batch's heap — up to ~4.4 GB live — collected as it nears
              // that, not at ~2.7× it (`packages/heap-pacing`).
              env: pacedHeapEnv(process.env),
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
          // Kept for a measurement: every job file and `.d.ts` a batch read,
          // so `scripts/batch-memory-bench.ts` can replay a real batch. One
          // subdirectory per run (the spool's unique name), never merged.
          const keep = readEnvPath("TYPE_CHECK_KEEP_BATCHES");
          try {
            if (keep !== undefined) {
              cpSync(spool, joinAppPath(keep, basename(spool)), {
                recursive: true,
                errorOnExist: true,
                force: false,
              });
            }
          } finally {
            rmSync(spool, { recursive: true, force: true });
          }
        },
      };
    },
  };
}
