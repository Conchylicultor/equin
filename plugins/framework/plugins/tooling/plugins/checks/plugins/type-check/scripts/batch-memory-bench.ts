// ─── What does one REAL type-check batch cost, under which runtime settings? ─
//
//   EQUIN_TYPE_CHECK_KEEP_BATCHES=<dir> ./equin check type-check   # a batched run: <dir>/type-check-batches-*
//   ./equin run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/batch-memory-bench.ts \
//     --kept <dir>/type-check-batches-<id> --root <checkout at the run's tree> [--jobs 0,6] \
//     [--variants default,smol,BUN_JSC_forceRAMSize=4000000000]
//
// Replays kept batches (`../shared/batch-processes.ts` copies a run's spool —
// every job file and the `.d.ts` its batches were served — into
// `TYPE_CHECK_KEEP_BATCHES`) through the real batch process, once per variant,
// one at a time, and prints each run's peak footprint, CPU and wall from rusage.
//
// A variant is `+`-joined parts: `default` (nothing), `smol` (bun `--smol`) or
// `NAME=value` (an environment variable, e.g. a `BUN_JSC_*` JSC option or
// `MIMALLOC_*`). Under `./equin run` the environment is already heap-paced
// (`packages/heap-pacing`), so the unpaced baseline is
// `BUN_JSC_forceRAMSize=<the host's RAM>`.
//
// `--root` must hold the run's tree byte for byte (a `git worktree add` of it,
// plus whatever uncommitted edits the run saw, `node_modules` linked in): a
// batch reads sources from disk and throws when one no longer hashes to the
// version the run gave it. Manual and heavy (a deep batch is ~2 CPU-min and
// ~7–10 GB): a measurement, run by hand, with no host admission. Results:
// research/2026-11-08-global-type-check-bun-heap-pacing.md.

import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { peakFootprintText } from "@plugins/packages/plugins/proc-rusage/core";
import { writeFileSync } from "fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { resolve } from "path";
import { fileURLToPath } from "url";
import type { BatchProcessJob } from "../shared/batch-worker";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

const BATCH_WORKER = fileURLToPath(
  new URL("../shared/batch-worker.ts", import.meta.url),
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const keptArg = arg("kept");
const rootArg = arg("root");
if (keptArg === undefined || rootArg === undefined) {
  console.error(
    "usage: batch-memory-bench.ts --kept <dir> --root <checkout> [--jobs 0,6] [--variants default,smol,NAME=value]",
  );
  process.exit(2);
}
const kept = asAppPath(resolve(keptArg));
const root = asAppPath(resolve(rootArg));
const jobs = (arg("jobs") ?? "0").split(",");
const variants = (arg("variants") ?? "default").split(",");

function variant(spec: string): {
  flags: string[];
  env: Record<string, string>;
} {
  const flags: string[] = [];
  const env: Record<string, string> = {};
  for (const part of spec.split("+")) {
    if (part === "default") continue;
    if (part === "smol") {
      flags.push("--smol");
      continue;
    }
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`batch-memory-bench: unknown part ${part}`);
    env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { flags, env };
}

const sec = (micros: number | undefined): string =>
  ((micros ?? NaN) / 1e6).toFixed(1);

for (const j of jobs) {
  const job = JSON.parse(
    readFileSync(joinAppPath(kept, `job-${j}.json`), "utf8"),
  ) as BatchProcessJob;
  const replay: BatchProcessJob = { ...job, spool: kept, root };
  const jobPath = joinAppPath(kept, `replay-${j}.json`);
  writeFileSync(jobPath, JSON.stringify(replay));
  for (const spec of variants) {
    const { flags, env } = variant(spec);
    const startedAt = performance.now();
    const run = await spawnCaptured(
      [process.execPath, ...flags, BATCH_WORKER, jobPath],
      {
        cwd: replay.root,
        env: { ...process.env, ...env },
        peakFootprint: "report",
        unbounded:
          "a measurement run by hand: one batch of a cold type check, minutes long, owned by the person who started it",
      },
    );
    const wallS = (performance.now() - startedAt) / 1000;
    const u = run.resourceUsage;
    console.log(
      `job ${j} (${job.sources.length} sources) ${spec}: exit ${run.exitCode}, ${peakFootprintText(u.peakFootprint)}, ` +
        `cpu ${sec(u.cpuTimeMicros)}s (sys ${sec(u.cpuSystemMicros)}), wall ${wallS.toFixed(1)}s`,
    );
    if (run.exitCode !== 0) console.log(run.stderr.trim().slice(-2000));
  }
}
