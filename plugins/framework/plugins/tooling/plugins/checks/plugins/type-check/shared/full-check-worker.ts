/**
 * The dual run's ORACLE (`./full-check.ts`) in a process of its own
 * (`./full-check-process.ts`): one fresh whole program over every root, and
 * nothing else in the process — so its memory is the whole program's alone,
 * measured on its own, never stacked on what the worker holds of its walks.
 *
 * Protocol: argv[2] is a JSON job file (`FullCheckJob`). stdout is one
 * `FullCheckOutput`. A nonzero exit means the oracle itself crashed.
 */
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { exitWithParent } from "@plugins/packages/plugins/flock/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { fullCheck } from "./full-check";
import type { FullCheckJob, FullCheckOutput } from "./full-check-process";
import { openRepoView } from "./repo-view";

async function run(job: FullCheckJob): Promise<FullCheckOutput> {
  const view = await openRepoView(job.root, job.tree);
  const full = fullCheck(view, job.options, job.roots);
  return {
    results: [...full.results],
    programDiagnostics: full.programDiagnostics,
  };
}

// A multi-GB process whose only reader is the worker that spawned it: when that
// worker dies, this must die too.
exitWithParent();

const jobArg = process.argv[2];
if (!jobArg) {
  console.error("type-check full check: missing job file argument");
  process.exit(2);
}
const job = JSON.parse(readFileSync(asAppPath(jobArg), "utf8")) as FullCheckJob;
const output = await run(job);
// Awaited to the last byte, because the exit below follows at once — and not
// a bare writeSync, which a non-blocking stdout pipe cuts short with EAGAIN
// or a short write (packages/blocking-write).
await Bun.write(Bun.stdout, JSON.stringify(output));
// Explicit: `exitWithParent`'s lifeline thread parks in a blocking FFI flock,
// which an emptied event loop must not wait on.
process.exit(0);
