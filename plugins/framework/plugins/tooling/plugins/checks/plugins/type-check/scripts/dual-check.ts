// ─── Does the keyed check ever differ from a full check? ─────────────────────
//
//   ./singularity run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/dual-check.ts \
//     <checkout> [--json <out.json>]
//
// Runs the type-check worker on `<checkout>`'s tree in `dual` mode: the keyed
// check over the host-wide checked-results store (what a check run does), then
// a full check of a fresh program beside it, compared file by file
// (`../shared/keyed-check.ts`). Prints the worker's lines, its CPU per phase,
// and every divergence; exit 1 on any. The full check's results overwrite the
// store, so a run also warms it for the next.
//
// The correctness gate for any change to the keyed check, and how it was
// validated before it decided verdicts: run it on a tree, apply a commit, run
// it again — the second run's keyed walk is the incremental one under test.
// Point `SINGULARITY_DIR` at a scratch directory to keep the store isolated
// from the fleet's.
//
// Manual and expensive: two program builds and a full check (minutes, ~15 GB).
// No host admission — this is a measurement, run by hand.

import { rmSync, writeFileSync } from "fs";
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
if (root === undefined) {
  console.error("usage: dual-check.ts <checkout> [--json <out.json>]");
  process.exit(2);
}

const job: TypeCheckWorkerJob = {
  root,
  name: "dual",
  tsconfigPath: join(root, "tsconfig.json"),
  manifestPath: join(os.tmpdir(), `dual-check-${process.pid}.program.json`),
  tscMode: "dual",
  lintFiles: [],
  typeFps: false,
};
const jobPath = join(os.tmpdir(), `dual-check-${process.pid}.json`);
writeFileSync(jobPath, JSON.stringify(job));
const run = await spawnCaptured([process.execPath, WORKER, jobPath], {
  cwd: root,
  unbounded:
    "a measurement run by hand: two program builds and a full check, minutes long, owned by the person who started it",
});
rmSync(job.manifestPath, { force: true });
process.stderr.write(run.stderr);
if (run.exitCode !== 0) {
  console.error(`dual-check: the worker exited ${run.exitCode}`);
  process.exit(2);
}
const result = JSON.parse(run.stdout) as TypeCheckWorkerResult;
for (const line of result.tscLines) console.log(line);
const { program, check, full } = result.phaseCpuSeconds;
console.log(
  `dual-check: cpu program ${program.toFixed(1)}s, keyed check ${check.toFixed(1)}s, full check ${full.toFixed(1)}s`,
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
