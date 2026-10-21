// ─── Does the two-program check ever differ from a full check? ──────────────
//
//   ./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/dual-check.ts \
//     <checkout> [--mode keyed|dual] [--json <out.json>]
//
// `--mode keyed` runs the two-program check alone (what a check run's tsc half
// costs, with its CPU, peak and program sizes) — no full check beside it.
//
// Runs the type-check worker on `<checkout>`'s tree in `dual` mode: the
// two-program check over the host-wide store (what a check run does), then a
// full check of a fresh whole program beside it, compared file by file
// (`../shared/full-check.ts`). Prints the worker's lines, its CPU per phase,
// and every divergence; exit 1 on any. On a divergence a cold run rewrites the
// store.
//
// The correctness gate for any change to the type check, and how it was
// validated before it decided verdicts: run it on a tree, apply a commit, run
// it again — the second run is the incremental one under test.
// Point `SINGULARITY_DIR` at a scratch directory to keep the store isolated
// from the fleet's.
//
// Manual and expensive: two program builds and a full check (minutes, ~15 GB).
// No host admission — this is a measurement, run by hand.

import { writeFileSync } from "fs";
import os from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type { TypeCheckWorkerJob, TypeCheckWorkerResult } from "../core";

const WORKER = fileURLToPath(new URL("../shared/worker.ts", import.meta.url));

const args = process.argv.slice(2);
const root = args[0] ? resolve(args[0]) : undefined;
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const modeAt = args.indexOf("--mode");
const mode = modeAt >= 0 ? args[modeAt + 1] : "dual";
if (root === undefined || (mode !== "keyed" && mode !== "dual")) {
  console.error(
    "usage: dual-check.ts <checkout> [--mode keyed|dual] [--json <out.json>]",
  );
  process.exit(2);
}

const job: TypeCheckWorkerJob = {
  root,
  name: "dual",
  tsconfigPath: join(root, "tsconfig.json"),
  tscMode: mode,
  // A miss is what this script is run to find: it fails the run.
  onMiss: "throw",
  lintFiles: [],
  typedParts: { split: [], whole: [] },
  versions: {},
};
const jobPath = join(os.tmpdir(), `dual-check-${process.pid}.json`);
writeFileSync(jobPath, JSON.stringify(job));
const run = await spawnCaptured([process.execPath, WORKER, jobPath], {
  cwd: root,
  unbounded:
    "a measurement run by hand: two program builds and a full check, minutes long, owned by the person who started it",
});
process.stderr.write(run.stderr);
if (run.exitCode !== 0) {
  console.error(`dual-check: the worker exited ${run.exitCode}`);
  process.exit(2);
}
const result = JSON.parse(run.stdout) as TypeCheckWorkerResult;
for (const line of result.tscLines) console.log(line);
const { check, full } = result.phaseCpuSeconds;
const usage = run.resourceUsage;
console.log(
  `dual-check: cpu two-program check ${check.toFixed(1)}s, full check ${full.toFixed(1)}s; ${result.stats.checked} files checked; ` +
    `process cpu ${((usage.cpuTimeMicros ?? NaN) / 1e6).toFixed(1)}s, maxRSS ${((usage.maxRssBytes ?? NaN) / 1e9).toFixed(2)} GB`,
);
for (const d of result.divergences) {
  console.log(
    `DIVERGES ${d.kind} ${d.file}\n  keyed: ${d.keyed}\n  full:  ${d.full}`,
  );
}
if (jsonOut !== undefined) {
  writeFileSync(
    jsonOut,
    JSON.stringify({ root, ...result, lint: undefined }, null, 2),
  );
}
process.exit(result.divergences.length > 0 ? 1 : 0);
