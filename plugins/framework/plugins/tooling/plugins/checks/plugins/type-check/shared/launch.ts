// THE way to start a type-check worker (`./worker.ts`), for every spawner —
// the check's (`../server/internal/spawn-worker.ts`) and the measurement
// scripts'. What the worker leaves on disk is owned here, by the process that
// outlives it:
//
// - the job goes in on stdin (`spawnCaptured`'s whole-buffer stdin, a file in
//   the spawn's own private dir that the spawn removes however the child
//   ends), so there is no job file for a crashed worker to leave behind;
// - the worker's scratch dir (its batch spool: `./batch-processes.ts`) is made
//   here before the spawn and removed here after it, in a `finally`. The worker
//   is handed it in the job (`scratch`, a required field), so it has no place
//   of its own to create one.
//
// Before, the job was `/tmp/type-check-<name>-<pid>.json`, deleted only by the
// worker after a run that returned, and the spool was the worker's own
// `mkdtemp`: a worker that threw or was killed left both behind for good (29
// job files of 14–21 MB on 2026-11-12, a spool of ~11k `.d.ts`).
//
// Imports nothing heavy: the check's server barrel reaches this module, and
// every backend's closure with it (`boot:closure-no-dev-tooling`).

import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { SpawnResult } from "@plugins/infra/plugins/spawn/core";
import { mkdtemp, rm } from "node:fs/promises";
import os from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import type { TypeCheckWorkerJob } from "../core";

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** A job as its spawner states it: the scratch dir is the launcher's to give. */
export type TypeCheckWorkerRequest = Omit<TypeCheckWorkerJob, "scratch">;

/**
 * Run the worker on `job`, through `spawn` (the caller's admission, cwd, env
 * and bound — it must pass `io` through to `spawnCaptured`). Returns the
 * spawn's result as is: reading the exit and the output is the caller's.
 */
export async function launchTypeCheckWorker(
  job: TypeCheckWorkerRequest,
  spawn: (argv: string[], io: { stdin: string }) => Promise<SpawnResult>,
): Promise<SpawnResult> {
  const scratch: AppPath = asAppPath(
    await mkdtemp(join(os.tmpdir(), "type-check-worker-")),
  );
  try {
    const full: TypeCheckWorkerJob = { ...job, scratch };
    return await spawn([process.execPath, WORKER], {
      stdin: JSON.stringify(full),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
